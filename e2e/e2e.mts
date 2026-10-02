// End-to-end suite for PR #8 against a running `next start` (port 3100) + fakes (4010).
// Usage: tsx e2e/e2e.mts <phase>, normally via e2e/run.sh (see e2e/README.md for the phases).
import pg from "pg";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { decryptSecret } from "../src/lib/secret-box";

const S = process.env.E2E_DIR!;
const PHASE = process.argv[2] ?? "A";
const APP = "http://localhost:3100";
const FAKE = "http://127.0.0.1:4010";
const secrets = JSON.parse(readFileSync(`${S}/secrets.json`, "utf8"));
const statePath = `${S}/state.json`;
const st: Record<string, any> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

/* ---------------- tiny harness ---------------- */
const results: { phase: string; name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ phase: PHASE, name, ok, detail: ok ? undefined : JSON.stringify(detail)?.slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"} [${PHASE}] ${name}${ok ? "" : `  -> ${JSON.stringify(detail)?.slice(0, 400)}`}`);
}
const rnd = () => randomBytes(8).toString("hex");
const tokenOf = (url: string) => url.split("/").pop()!;
/** Random parts of every plaintext credential: none may appear in any response/page/log. */
function leakNeedles(): string[] {
  return [
    secrets.contextDevApiKey, secrets.openaiApiKey, secrets.resendApiKey, secrets.webhookSecret,
    tokenOf(secrets.slackWebhookUrl), tokenOf(secrets.alertWebhookUrl), tokenOf(secrets.callbackUrl), tokenOf(secrets.queuedUrl),
    ...(st.extraTokens ?? []),
    ...(st.extraSecrets ?? []),
  ];
}
function noLeak(label: string, text: string) {
  const found = leakNeedles().filter((n) => text.includes(n));
  check(`no plaintext credential in ${label}`, found.length === 0, found.map((f) => f.slice(0, 6) + "…"));
}
const MASK_RE = /••••|\\u2022\\u2022\\u2022\\u2022/;

let cookie = "";
async function app(path: string, init: RequestInit & { json?: unknown; anon?: boolean } = {}) {
  const headers: Record<string, string> = { origin: APP, ...(init.headers as Record<string, string>) };
  if (!init.anon && cookie) headers.cookie = cookie;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(APP + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: "manual" });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, body, res };
}
async function v1(path: string, init: { method?: string; json?: unknown } = {}, key: string = secrets.apiKey) {
  return app(path, { ...init, anon: true, headers: { authorization: `Bearer ${key}` } });
}
async function fake(path: string, json?: unknown) {
  const r = await fetch(FAKE + path, { method: json === undefined ? "GET" : "POST", body: json === undefined ? undefined : JSON.stringify(json) });
  return r.json() as Promise<any>;
}
const setState = (s: unknown) => fake("/_state", s);
const fakeLog = () => fake("/_log") as Promise<any[]>;
const resetLog = () => fake("/_reset-log", {});
/** Independent receiver-side verification (not the app's helper). */
function verifySig(header: string | undefined, body: string, secret: string): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const exp = createHmac("sha256", secret).update(`${m[1]}.${body}`).digest();
  return Math.abs(Date.now() / 1000 - Number(m[1])) < 300 && timingSafeEqual(exp, Buffer.from(m[2]!, "hex"));
}
const recvFor = async (tok: string) => (await fakeLog()).filter((e) => e.path === `/recv/${tok}`);
async function signIn() {
  const r = await fetch(`${APP}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ email: secrets.email, password: secrets.password }),
  });
  cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  check("sign in (seeded legacy user)", r.status === 200 && cookie.includes("session_token"), r.status);
}
async function dbValue(table: string, col: string, pkCol: string, pk: string, purpose: string) {
  const raw = (await db.query(`SELECT "${col}" AS v FROM "${table}" WHERE "${pkCol}"=$1`, [pk])).rows[0]?.v as string | null;
  return { raw, plain: raw == null ? null : decryptSecret(raw, purpose) };
}
const page = (n: number) => `# News\n\nHeadline ${n}: things changed (${rnd()})\n`;
async function settingsMaskCheck(label: string) {
  const s = await app("/api/user/notification-settings");
  const last4 = (v: string) => `••••${v.slice(-4)}`;
  check(`${label}: settings GET masks keys (last 4 of the real key)`,
    s.status === 200 && s.body.contextDevApiKey === last4(secrets.contextDevApiKey) && s.body.openaiApiKey === last4(secrets.openaiApiKey) && s.body.resendApiKey === last4(secrets.resendApiKey),
    s.body);
  noLeak(`${label}: settings GET`, s.text);
}

/* ================= PHASE A ================= */
if (PHASE === "A") {
  st.extraTokens = [];
  const health = await app("/api/health", { anon: true });
  check("health", health.status === 200, health.status);
  await signIn();

  // --- dashboard: settings + destinations (decrypted server-side, masked to the browser)
  await settingsMaskCheck("dashboard");
  const settingsPage = await app("/dashboard/settings");
  check("settings page renders", settingsPage.status === 200, settingsPage.status);
  noLeak("settings page HTML/RSC", settingsPage.text);
  check("settings page carries masked values", MASK_RE.test(settingsPage.text));
  const dests = await app("/api/user/notification-destinations");
  const byId = Object.fromEntries((dests.body?.destinations ?? []).map((d: any) => [d.id, d]));
  check("destinations GET masks Slack + webhook URLs",
    byId[secrets.ids.slack]?.slackWebhookUrl === "https://hooks.slack.com/services/••••" + secrets.slackWebhookUrl.slice(-4) &&
    MASK_RE.test(byId[secrets.ids.hook]?.alertWebhookUrl ?? ""), byId);
  noLeak("destinations GET", dests.text);

  // --- notification test sends: each uses the decrypted credential internally
  await resetLog();
  const tHook = await app("/api/user/notification-settings/test", { method: "POST", json: { destinationId: secrets.ids.hook } });
  const tSlack = await app("/api/user/notification-settings/test", { method: "POST", json: { destinationId: secrets.ids.slack } });
  const tEmail = await app("/api/user/notification-settings/test", { method: "POST", json: { destinationId: secrets.ids.email } });
  const log1 = await fakeLog();
  check("webhook destination test reaches the exact (decrypted) URL", tHook.status === 200 && log1.some((e) => e.path === `/recv/${tokenOf(secrets.alertWebhookUrl)}`), { s: tHook.body });
  check("Slack destination test reaches the exact (decrypted) Slack URL", tSlack.status === 200 && log1.some((e) => e.path === new URL(secrets.slackWebhookUrl).pathname.replace(/^/, "/slack")), { s: tSlack.body });
  check("email test authenticates to Resend with the decrypted key", tEmail.status === 200 && log1.some((e) => e.path === "/resend/emails" && e.headers.authorization === `Bearer ${secrets.resendApiKey}`), { s: tEmail.body });
  noLeak("destination test responses", tHook.text + tSlack.text + tEmail.text);

  // --- API: legacy watch callback is masked; webhook test signs with the decrypted secret
  const list = await v1("/api/v1/watches");
  const legacy = list.body?.watches?.find((w: any) => w.id === secrets.ids.target);
  check("v1 list: legacy (backfilled) callbackUrl is masked", legacy && MASK_RE.test(legacy.callbackUrl) && legacy.callbackUrl.startsWith("http://127.0.0.1:4010/recv/"), legacy);
  noLeak("v1 watch list", list.text);
  const wtTok = `wtest-${rnd()}`; st.extraTokens.push(wtTok);
  const wt = await v1("/api/v1/webhooks/test", { method: "POST", json: { url: `${FAKE}/recv/${wtTok}` } });
  const [wtReq] = await recvFor(wtTok);
  const secretCipher = (await db.query(`SELECT "webhookSecret" AS v FROM "apiClient" WHERE id=$1`, [secrets.ids.apiClient])).rows[0].v;
  check("webhook.test delivered and verifies with the real secret", wt.body?.delivered === true && verifySig(wtReq?.headers["x-watcher-signature"], wtReq?.body, secrets.webhookSecret), wt.body);
  check("signature does NOT verify with the stored ciphertext", secretCipher.startsWith("enc:v1:") && !verifySig(wtReq?.headers["x-watcher-signature"], wtReq?.body, secretCipher));

  // --- Phase 1: create a page watch (Context.dev called with the decrypted per-account key)
  const newsUrl = "https://shop-e2e.example.com/news";
  await setState({ pages: { [newsUrl]: page(1), "https://legacy-shop.example.com/news": page(1) } });
  await resetLog();
  const cbTok = `cb1-${rnd()}`; st.extraTokens.push(cbTok);
  const cbUrl = `${FAKE}/recv/${cbTok}`;
  const created = await v1("/api/v1/watches", { method: "POST", json: { url: newsUrl, type: "page", callbackUrl: cbUrl, externalRef: "e2e-page-1" } });
  check("P1 create page watch (baseline completed)", created.status === 201 && created.body.baseline.status === "completed", created.body);
  check("P1 create response masks callbackUrl", created.body?.watch?.callbackUrl === `http://127.0.0.1:4010/recv/••••${cbTok.slice(-4)}`, created.body?.watch?.callbackUrl);
  check("P1 Context.dev called with the decrypted per-account key",
    (await fakeLog()).some((e) => e.path === "/ctx/web/scrape/markdown" && e.headers.authorization === `Bearer ${secrets.contextDevApiKey}`));
  const w1 = created.body.watch;
  st.w1 = { id: w1.id, websiteId: w1.websiteId, url: newsUrl, cbTok };
  const stored = await dbValue("target", "callbackUrl", "id", w1.id, "target.callbackUrl");
  check("P1 callbackUrl stored encrypted, decrypts to the real URL", stored.raw!.startsWith("enc:v1:") && stored.plain === cbUrl);
  const replay = await v1("/api/v1/watches", { method: "POST", json: { url: newsUrl, type: "page", callbackUrl: cbUrl, externalRef: "e2e-page-1" } });
  check("P1 externalRef replay returns the same watch", replay.body?.replayed === true && replay.body.watch.id === w1.id, replay.body);
  const maskedCreate = await v1("/api/v1/watches", { method: "POST", json: { url: "https://shop-e2e.example.com/other", type: "page", callbackUrl: created.body.watch.callbackUrl } });
  check("P1 masked callbackUrl rejected on create", maskedCreate.status === 422, maskedCreate.body);
  const maskedPatch = await v1(`/api/v1/watches/${w1.id}`, { method: "PATCH", json: { callbackUrl: created.body.watch.callbackUrl } });
  check("P1 masked callbackUrl rejected on PATCH", maskedPatch.status === 422, maskedPatch.body);
  check("P1 stored callbackUrl unchanged after rejected masked PATCH", (await dbValue("target", "callbackUrl", "id", w1.id, "target.callbackUrl")).plain === cbUrl);

  // change → triggered event, signed, sent to the exact URL, payload without callbackUrl
  await setState({ pages: { [newsUrl]: page(2) } });
  const chk = await v1(`/api/v1/watches/${w1.id}/check`, { method: "POST" });
  const evs = await recvFor(cbTok);
  const ev = evs.at(-1);
  const evBody = ev ? JSON.parse(ev.body) : null;
  check("P1 check → watch.triggered delivered to the exact callback URL", chk.status === 200 && evBody?.type === "watch.triggered", { chk: chk.body, n: evs.length });
  check("P1 event signature verifies with the decrypted secret", verifySig(ev?.headers["x-watcher-signature"], ev?.body, secrets.webhookSecret));
  check("P1 payload omits watch.callbackUrl", evBody && evBody.watch && !("callbackUrl" in evBody.watch), evBody?.watch);
  noLeak("P1 check response + event payload", chk.text + (ev?.body ?? ""));
  const outbox = (await db.query(`SELECT payload FROM "webhookDelivery" WHERE "targetId"=$1`, [w1.id])).rows;
  check("P1 stored outbox payload has no callback URL", outbox.length > 0 && outbox.every((r) => !r.payload.includes(cbTok)));
  const dl = await v1(`/api/v1/watches/${w1.id}/deliveries`);
  check("P1 deliveries list: delivered, url masked", dl.body?.deliveries?.[0]?.status === "delivered" && MASK_RE.test(dl.body.deliveries[0].url), dl.body?.deliveries?.[0]);
  noLeak("P1 deliveries list", dl.text);
  const evl = await v1(`/api/v1/watches/${w1.id}/events`);
  check("P1 events list", evl.status === 200, evl.status);
  noLeak("P1 events list", evl.text);

  // backfilled legacy watch: baseline, then a change → delivered to its (encrypted-by-backfill) URL
  await v1(`/api/v1/watches/${secrets.ids.target}/check`, { method: "POST" });
  await setState({ pages: { "https://legacy-shop.example.com/news": page(3) } });
  await v1(`/api/v1/watches/${secrets.ids.target}/check`, { method: "POST" });
  const lev = (await recvFor(tokenOf(secrets.callbackUrl))).at(-1);
  check("P1 legacy watch: event reaches its backfilled callback URL, signature verifies", !!lev && verifySig(lev.headers["x-watcher-signature"], lev.body, secrets.webhookSecret));

  // PATCH to a new real URL: accepted, masked in response, encrypted at rest
  const cb2Tok = `cb2-${rnd()}`; st.extraTokens.push(cb2Tok);
  const p2 = await v1(`/api/v1/watches/${w1.id}`, { method: "PATCH", json: { callbackUrl: `${FAKE}/recv/${cb2Tok}` } });
  check("P1 PATCH callbackUrl → masked in response, encrypted at rest",
    p2.status === 200 && MASK_RE.test(p2.body.watch.callbackUrl) && (await dbValue("target", "callbackUrl", "id", w1.id, "target.callbackUrl")).plain === `${FAKE}/recv/${cb2Tok}`, p2.body);
  st.w1.cbTok = cb2Tok;

  // --- Phase 2: conditions (price threshold; AI intent with the decrypted OpenAI key)
  const priceUrl = "https://shop-e2e.example.com/widget";
  await setState({ products: { [priceUrl]: { price: 60 } } });
  const pcTok = `price-${rnd()}`; st.extraTokens.push(pcTok);
  const pw = await v1("/api/v1/watches", { method: "POST", json: { url: priceUrl, type: "price", callbackUrl: `${FAKE}/recv/${pcTok}`, condition: { type: "price_below", value: 50, currency: "USD" } } });
  check("P2 price watch created; baseline condition not matched", pw.status === 201 && pw.body.baseline.condition?.status === "not_matched", pw.body?.baseline);
  await setState({ products: { [priceUrl]: { price: 40 } } });
  await v1(`/api/v1/watches/${pw.body.watch.id}/check`, { method: "POST" });
  const pev = (await recvFor(pcTok)).at(-1);
  const pevBody = pev ? JSON.parse(pev.body) : null;
  check("P2 price drop below threshold → triggered event, signed", pevBody?.type === "watch.triggered" && verifySig(pev.headers["x-watcher-signature"], pev.body, secrets.webhookSecret), pevBody?.type);

  const intentUrl = "https://shop-e2e.example.com/stock";
  await setState({ pages: { [intentUrl]: "# Stock\n\nRed widget: sold out\n" } });
  const icTok = `intent-${rnd()}`; st.extraTokens.push(icTok);
  const iw = await v1("/api/v1/watches", { method: "POST", json: { url: intentUrl, type: "page", intent: "Blue widget is in stock", callbackUrl: `${FAKE}/recv/${icTok}`, condition: { type: "intent" } } });
  check("P2 intent watch created (AI configured from encrypted per-account key)", iw.status === 201, iw.body);
  await resetLog();
  await setState({ pages: { [intentUrl]: "# Stock\n\nRed widget: sold out\nBlue widget: in stock\n" } });
  await v1(`/api/v1/watches/${iw.body.watch?.id}/check`, { method: "POST" });
  const ilog = await fakeLog();
  const ai = ilog.filter((e) => e.path.startsWith("/openai/"));
  check("P2 AI condition called OpenAI with the decrypted per-account key", ai.length > 0 && ai.every((e) => e.headers.authorization === `Bearer ${secrets.openaiApiKey}`), ai.map((e) => e.path));
  const iev = ilog.filter((e) => e.path === `/recv/${icTok}`).at(-1);
  check("P2 intent matched → triggered event, signed", !!iev && JSON.parse(iev.body).type === "watch.triggered" && verifySig(iev.headers["x-watcher-signature"], iev.body, secrets.webhookSecret));

  // --- Phase 3: retries (worker), failed → manual retry, watch.error / watch.recovered
  const rUrl = "https://shop-e2e.example.com/retry";
  const rTok = `retry-${rnd()}`; st.extraTokens.push(rTok);
  await setState({ pages: { [rUrl]: page(1) }, fail: { [rTok]: 500 } });
  const rw = await v1("/api/v1/watches", { method: "POST", json: { url: rUrl, type: "page", callbackUrl: `${FAKE}/recv/${rTok}` } });
  await setState({ pages: { [rUrl]: page(2) } });
  await v1(`/api/v1/watches/${rw.body.watch.id}/check`, { method: "POST" });
  const rd = (await db.query(`SELECT id,status,attempts,"lastStatusCode" FROM "webhookDelivery" WHERE "targetId"=$1`, [rw.body.watch.id])).rows[0];
  check("P3 receiver 500 → delivery pending for retry", rd?.status === "pending" && rd.attempts === 1 && rd.lastStatusCode === 500, rd);
  await setState({ fail: { [rTok]: 200 } });
  await db.query(`UPDATE "webhookDelivery" SET "nextAttemptAt"=now() WHERE id=$1`, [rd.id]);
  // Also make the backfilled legacy delivery due (it already is) and run the worker once.
  const workerOut = execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
  writeFileSync(`${S}/worker-A.log`, workerOut);
  const rd2 = (await db.query(`SELECT status,attempts FROM "webhookDelivery" WHERE id=$1`, [rd.id])).rows[0];
  const retryReqs = await recvFor(rTok);
  const lastRetry = retryReqs.at(-1);
  check("P3 worker retry delivers (attempt 2), signature verifies", rd2.status === "delivered" && rd2.attempts === 2 && lastRetry?.headers["x-watcher-attempt"] === "2" && verifySig(lastRetry.headers["x-watcher-signature"], lastRetry.body, secrets.webhookSecret), { rd2, n: retryReqs.length });
  const q = (await recvFor(tokenOf(secrets.queuedUrl))).at(-1);
  const qrow = (await db.query(`SELECT status FROM "webhookDelivery" WHERE id=$1`, [secrets.ids.delivery])).rows[0];
  check("P3 pre-migration queued delivery: worker decrypts its URL, delivers, signature verifies", qrow.status === "delivered" && !!q && verifySig(q.headers["x-watcher-signature"], q.body, secrets.webhookSecret), qrow);

  const gTok = `gone-${rnd()}`; st.extraTokens.push(gTok);
  const gUrl = "https://shop-e2e.example.com/gone";
  await setState({ pages: { [gUrl]: page(1) }, fail: { [gTok]: 410 } });
  const gw = await v1("/api/v1/watches", { method: "POST", json: { url: gUrl, type: "page", callbackUrl: `${FAKE}/recv/${gTok}` } });
  await setState({ pages: { [gUrl]: page(2) } });
  await v1(`/api/v1/watches/${gw.body.watch.id}/check`, { method: "POST" });
  const gd = (await db.query(`SELECT id,status FROM "webhookDelivery" WHERE "targetId"=$1`, [gw.body.watch.id])).rows[0];
  check("P3 410 Gone → delivery failed (permanent)", gd?.status === "failed", gd);
  await setState({ fail: { [gTok]: 200 } });
  const rr = await v1(`/api/v1/deliveries/${gd.id}/retry`, { method: "POST" });
  const gLast = (await recvFor(gTok)).at(-1);
  check("P3 manual retry of failed delivery succeeds, signed, url masked", rr.body?.delivery?.status === "delivered" && MASK_RE.test(rr.body.delivery.url) && verifySig(gLast?.headers["x-watcher-signature"], gLast?.body, secrets.webhookSecret), rr.body);
  noLeak("P3 retry response", rr.text);

  await setState({ pages: { [newsUrl]: { error: 500 } } });
  await v1(`/api/v1/watches/${w1.id}/check`, { method: "POST" });
  await v1(`/api/v1/watches/${w1.id}/check`, { method: "POST" });
  await setState({ pages: { [newsUrl]: page(9) } });
  await v1(`/api/v1/watches/${w1.id}/check`, { method: "POST" });
  const types = (await recvFor(st.w1.cbTok)).map((e) => JSON.parse(e.body).type);
  check("P3 failures → watch.error, then watch.recovered (to the PATCHed URL)", types.includes("watch.error") && types.includes("watch.recovered"), types);

  // --- dashboard pages/APIs for websites holding API watches
  for (const [label, websiteId] of [["new", w1.websiteId], ["legacy", secrets.ids.website]] as const) {
    const wp = await app(`/dashboard/websites/${websiteId}`);
    check(`dashboard website page (${label}) renders`, wp.status === 200, wp.status);
    noLeak(`dashboard website page (${label}) HTML/RSC`, wp.text);
    check(`dashboard website page (${label}) carries the masked callback URL`, /4010\/recv\/(••••|\\u2022)/.test(wp.text));
    const wj = await app(`/api/websites/${websiteId}`);
    check(`GET /api/websites/:id (${label}): callbackUrl masked`, wj.status === 200 && wj.body.targets.filter((t: any) => t.callbackUrl).every((t: any) => MASK_RE.test(t.callbackUrl)) && wj.body.targets.some((t: any) => t.callbackUrl), wj.body?.targets?.map((t: any) => t.callbackUrl));
    noLeak(`GET /api/websites/:id (${label})`, wj.text);
  }
  const tp = await app(`/api/targets/${w1.id}`, { method: "PATCH", json: { aiTriageEnabled: false } });
  check("PATCH /api/targets/:id returns masked callbackUrl", tp.status === 200 && MASK_RE.test(tp.body.target.callbackUrl), tp.body);
  noLeak("PATCH /api/targets/:id", tp.text);
  check("dashboard PATCH left the stored callback URL intact", (await dbValue("target", "callbackUrl", "id", w1.id, "target.callbackUrl")).plain === `${FAKE}/recv/${st.w1.cbTok}`);
  const dash = await app("/dashboard");
  noLeak("dashboard home", dash.text);

  // --- public share page: no callback URL at all (neither plaintext nor masked)
  for (const [label, websiteId] of [["new", w1.websiteId], ["legacy", secrets.ids.website]] as const) {
    const sh = await app(`/api/websites/${websiteId}/share`, { method: "POST" });
    const sp = await app(`/share/${sh.body.publicShareToken}`, { anon: true });
    check(`share page (${label}) renders without login`, sp.status === 200, sp.status);
    noLeak(`share page (${label})`, sp.text);
    check(`share page (${label}) has no callback URL, not even masked`, !sp.text.includes("4010") && !sp.text.includes("/recv/") && !MASK_RE.test(sp.text) && /"callbackUrl":null|\\"callbackUrl\\":null/.test(sp.text));
    st[`share_${label}`] = sh.body.publicShareToken;
  }

  // --- masked values sent back are never stored as credentials
  const before = await Promise.all(["contextDevApiKey", "openaiApiKey", "resendApiKey"].map((c) => dbValue("userNotificationSettings", c, "userId", secrets.ids.user, `userNotificationSettings.${c}`)));
  const masked = await app("/api/user/notification-settings");
  const pm = await app("/api/user/notification-settings", { method: "PATCH", json: { contextDevApiKey: masked.body.contextDevApiKey, openaiApiKey: masked.body.openaiApiKey, resendApiKey: masked.body.resendApiKey } });
  const after = await Promise.all(["contextDevApiKey", "openaiApiKey", "resendApiKey"].map((c) => dbValue("userNotificationSettings", c, "userId", secrets.ids.user, `userNotificationSettings.${c}`)));
  check("settings PATCH with masked keys keeps the real keys", pm.status === 200 && after.map((a) => a.plain).join() === [secrets.contextDevApiKey, secrets.openaiApiKey, secrets.resendApiKey].join() && before.map((b) => b.plain).join() === after.map((a) => a.plain).join(), pm.body);
  noLeak("settings PATCH response", pm.text);
  const dm = await app(`/api/user/notification-destinations/${secrets.ids.hook}`, { method: "PATCH", json: { name: "Renamed hook", alertWebhookUrl: byId[secrets.ids.hook].alertWebhookUrl } });
  const sm = await app(`/api/user/notification-destinations/${secrets.ids.slack}`, { method: "PATCH", json: { slackWebhookUrl: byId[secrets.ids.slack].slackWebhookUrl } });
  check("destination PATCH with masked URLs keeps the real URLs",
    dm.status === 200 && sm.status === 200 &&
    (await dbValue("notificationDestination", "alertWebhookUrl", "id", secrets.ids.hook, "notificationDestination.alertWebhookUrl")).plain === secrets.alertWebhookUrl &&
    (await dbValue("notificationDestination", "slackWebhookUrl", "id", secrets.ids.slack, "notificationDestination.slackWebhookUrl")).plain === secrets.slackWebhookUrl, { dm: dm.body, sm: sm.body });
  noLeak("destination PATCH responses", dm.text + sm.text);
  const dc = await app("/api/user/notification-destinations", { method: "POST", json: { channel: "WEBHOOK", name: "Masked", alertWebhookUrl: byId[secrets.ids.hook].alertWebhookUrl } });
  const sc = await app("/api/user/notification-destinations", { method: "POST", json: { channel: "SLACK", name: "Masked", slackWebhookUrl: byId[secrets.ids.slack].slackWebhookUrl } });
  check("creating a destination from a masked URL is rejected", dc.status === 400 && sc.status === 400, { dc: dc.status, sc: sc.status });
  const models = await app("/api/user/ai-models?provider=openai");
  await resetLog();
  const models2 = await app("/api/user/ai-models", { method: "POST", json: { provider: "openai", apiKey: masked.body.openaiApiKey } });
  check("AI model list with masked draft key uses the stored key", [models.status, models2.status].some((s) => s === 200) && (await fakeLog()).filter((e) => e.path.startsWith("/openai/")).every((e) => e.headers.authorization === `Bearer ${secrets.openaiApiKey}`), { a: models.status, b: models2.status });
  noLeak("AI model list responses", models.text + models2.text);
  save();
}

/* ================= PHASE B: after restart with the same key ================= */
if (PHASE === "B") {
  await signIn();
  await settingsMaskCheck("after restart");
  await resetLog();
  const tHook = await app("/api/user/notification-settings/test", { method: "POST", json: { destinationId: secrets.ids.hook } });
  const tSlack = await app("/api/user/notification-settings/test", { method: "POST", json: { destinationId: secrets.ids.slack } });
  const tEmail = await app("/api/user/notification-settings/test", { method: "POST", json: { destinationId: secrets.ids.email } });
  const log = await fakeLog();
  check("after restart: webhook, Slack and email destinations still decrypt and send",
    tHook.status === 200 && tSlack.status === 200 && tEmail.status === 200 &&
    log.some((e) => e.path === `/recv/${tokenOf(secrets.alertWebhookUrl)}`) &&
    log.some((e) => e.path === new URL(secrets.slackWebhookUrl).pathname.replace(/^/, "/slack")) &&
    log.some((e) => e.path === "/resend/emails" && e.headers.authorization === `Bearer ${secrets.resendApiKey}`));
  await setState({ pages: { [st.w1.url]: page(42) } });
  const chk = await v1(`/api/v1/watches/${st.w1.id}/check`, { method: "POST" });
  const ev = (await recvFor(st.w1.cbTok)).at(-1);
  check("after restart: Context.dev key decrypts (check ran) and event is delivered + verifies",
    chk.status === 200 && (await fakeLog()).some((e) => e.path === "/ctx/web/scrape/markdown" && e.headers.authorization === `Bearer ${secrets.contextDevApiKey}`) &&
    !!ev && verifySig(ev.headers["x-watcher-signature"], ev.body, secrets.webhookSecret), chk.body);
  const sp = await app(`/share/${st.share_legacy}`, { anon: true });
  check("after restart: share page still has no callback URL", sp.status === 200 && !sp.text.includes("4010") && !MASK_RE.test(sp.text));
}

/* ================= PHASE C: SSRF with the production default ================= */
if (PHASE === "C") {
  await signIn();
  const urls = ["http://127.0.0.1:4010/recv/ssrf", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/hook", "http://localhost:4010/recv/ssrf", "http://[::1]:4010/recv/ssrf"];
  for (const u of urls) {
    const r = await v1("/api/v1/watches", { method: "POST", json: { url: "https://shop-e2e.example.com/ssrf", type: "page", callbackUrl: u, baseline: false } });
    check(`SSRF: watch callback ${new URL(u).host} rejected`, r.status === 422 && r.body?.error?.code === "callback_url_not_allowed", r.body);
  }
  const wt = await v1("/api/v1/webhooks/test", { method: "POST", json: { url: "http://192.168.1.10/hook" } });
  check("SSRF: webhook test to a private address rejected", wt.status === 422, wt.body);
  const dc = await app("/api/user/notification-destinations", { method: "POST", json: { channel: "WEBHOOK", name: "Private", alertWebhookUrl: "http://192.168.1.10/hook" } });
  check("SSRF: dashboard webhook destination to a private address rejected", dc.status === 400, dc.body);
  // An existing watch whose stored (encrypted) callback now resolves to a blocked address.
  await setState({ pages: { [st.w1.url]: page(77) } });
  await resetLog();
  await v1(`/api/v1/watches/${st.w1.id}/check`, { method: "POST" });
  const d = (await db.query(`SELECT status,"lastError" FROM "webhookDelivery" WHERE "targetId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [st.w1.id])).rows[0];
  check("SSRF: delivery to a stored private callback is blocked at send time (failed, not sent)", d?.status === "failed" && /^Blocked/.test(d.lastError ?? "") && (await recvFor(st.w1.cbTok)).length === 0, d);
  noLeak("SSRF delivery lastError", d?.lastError ?? "");
}

/* ================= PHASE R: revoked API clients (Phase 4.3) ================= */
if (PHASE === "R") {
  const { db: appDb } = await import("../src/lib/db");
  const schema = await import("../src/lib/db/schema");
  const { generateApiKey } = await import("../src/lib/api-keys");
  const { revokeApiClient } = await import("../src/lib/api-client-revocation");
  st.extraTokens ??= [];
  st.extraSecrets ??= [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A fresh API client of the seeded owner, with a known key and signing secret (stored encrypted). */
  async function newClient(name: string) {
    const k = generateApiKey();
    const id = `akey_${name}_${rnd()}`;
    const secret = `whsec_${randomBytes(32).toString("hex")}`;
    await appDb.insert(schema.apiClient).values({ id, ownerUserId: secrets.ids.user, name, keyPrefix: k.keyPrefix, keyHash: k.keyHash, webhookSecret: secret, createdAt: new Date() });
    st.extraSecrets.push(k.key, secret);
    return { id, key: k.key, secret };
  }
  async function watchFor(client: { key: string }, label: string, opts: Record<string, unknown> = {}) {
    const url = `https://shop-r.example.com/${label}-${rnd()}`;
    const tok = `${label}-${rnd()}`;
    st.extraTokens.push(tok);
    await setState({ pages: { [url]: page(1) } });
    const r = await v1("/api/v1/watches", { method: "POST", json: { url, type: "page", callbackUrl: `${FAKE}/recv/${tok}`, ...opts } }, client.key);
    if (r.status !== 201) throw new Error(`create ${label}: ${r.status} ${r.text}`);
    return { id: r.body.watch.id as string, websiteId: r.body.watch.websiteId as string, url, tok };
  }
  const targetRow = async (id: string) => (await db.query(`SELECT "lastCheckedAt","enabled" FROM target WHERE id=$1`, [id])).rows[0];
  const alertCount = async (id: string) => Number((await db.query(`SELECT count(*) FROM alert WHERE "targetId"=$1`, [id])).rows[0].count);
  const deliveries = async (id: string) => (await db.query(`SELECT id,status,"lastError","eventType" FROM "webhookDelivery" WHERE "targetId"=$1 ORDER BY "createdAt"`, [id])).rows;
  const revokedAtOf = async (id: string) => (await db.query(`SELECT "revokedAt" FROM "apiClient" WHERE id=$1`, [id])).rows[0].revokedAt as Date | null;

  await signIn();
  const X = await newClient("x");
  const Y = await newClient("y");
  const x1 = await watchFor(X, "x1");
  const x2 = await watchFor(X, "x2");
  const y1 = await watchFor(Y, "y1");
  // A dashboard (non-API) monitor on the same website, notifying the dashboard webhook destination.
  const dashId = `tgt_dash_${rnd()}`;
  const dashUrl = `https://shop-r.example.com/dash-${rnd()}`;
  await setState({ pages: { [dashUrl]: page(1) } });
  await appDb.insert(schema.target).values({ id: dashId, websiteId: x1.websiteId, kind: "PAGE_CONTENT", pageUrl: dashUrl, enabled: true, checkIntervalHours: 24, notificationDestinationId: secrets.ids.hook, externalNotify: true, createdAt: new Date() });
  await app("/api/cron/run", { method: "POST", json: { websiteId: x1.websiteId, targetId: dashId } });
  check("R setup: X and Y watches on one shared website; dashboard monitor alongside", x1.websiteId === y1.websiteId);

  // History before revocation: x1 delivered an event; x2's receiver is down so its event stays pending.
  await setState({ pages: { [x1.url]: page(2), [x2.url]: page(2) }, fail: { [x2.tok]: 500 } });
  await v1(`/api/v1/watches/${x1.id}/check`, { method: "POST" }, X.key);
  await v1(`/api/v1/watches/${x2.id}/check`, { method: "POST" }, X.key);
  const x1Hist = await deliveries(x1.id);
  const x2Before = await deliveries(x2.id);
  check("R before revoke: x1 delivered, x2 pending (receiver 500)", x1Hist.at(-1)?.status === "delivered" && x2Before.at(-1)?.status === "pending", { x1Hist, x2Before });
  const x1AlertsBefore = await alertCount(x1.id);

  // --- revoke X through the CLI
  const out1 = execFileSync("npm", ["run", "-s", "api-keys", "--", "revoke", X.id], { env: process.env, encoding: "utf8" });
  const x2After = await deliveries(x2.id);
  check("R revoke (CLI): reports it and cancels the pending delivery", /Revoked/.test(out1) && /Canceled 1 pending/.test(out1) && x2After.at(-1)?.status === "canceled" && /revoked/.test(x2After.at(-1)?.lastError ?? ""), { out1, x2After });
  const revokedAt1 = await revokedAtOf(X.id);
  check("R revoked key no longer authenticates", (await v1("/api/v1/watches", {}, X.key)).status === 401);

  // --- what a sibling key (Y) of the same account sees and may do
  const yList = await v1("/api/v1/watches?limit=100", {}, Y.key);
  const seen = Object.fromEntries((yList.body?.watches ?? []).map((w: any) => [w.id, w.status]));
  check("R sibling key: revoked watches listed with status \"revoked\"; its own stay active", seen[x1.id] === "revoked" && seen[x2.id] === "revoked" && seen[y1.id] === "active", seen);
  const g = await v1(`/api/v1/watches/${x1.id}`, {}, Y.key);
  check("R sibling key: GET revoked watch → 200, status revoked, enabled flag untouched", g.status === 200 && g.body.watch.status === "revoked" && g.body.watch.enabled === true, g.body?.watch?.status);
  const ev = await v1(`/api/v1/watches/${x1.id}/events`, {}, Y.key);
  const dl = await v1(`/api/v1/watches/${x2.id}/deliveries`, {}, Y.key);
  const dlx1 = await v1(`/api/v1/watches/${x1.id}/deliveries`, {}, Y.key);
  check("R history kept: events and deliveries of revoked watches remain readable", ev.status === 200 && (ev.body.events?.length ?? 0) >= 1 && dlx1.body?.deliveries?.some((d: any) => d.status === "delivered") && dl.body?.deliveries?.[0]?.status === "canceled", { ev: ev.body?.events?.length, dl: dl.body?.deliveries?.[0]?.status });
  const filtered = await v1(`/api/v1/watches/${x2.id}/deliveries?status=canceled`, {}, Y.key);
  check("R deliveries list filters by status=canceled", filtered.status === 200 && filtered.body.deliveries.length === 1, filtered.body);
  const mc = await v1(`/api/v1/watches/${x1.id}/check`, { method: "POST" }, Y.key);
  check("R manual check of revoked watch → 409 watch_revoked", mc.status === 409 && mc.body?.error?.code === "watch_revoked", mc.body);
  for (const body of [{ enabled: true }, { enabled: false }, { intervalMinutes: 60 }]) {
    const pr = await v1(`/api/v1/watches/${x1.id}`, { method: "PATCH", json: body }, Y.key);
    check(`R PATCH revoked watch ${JSON.stringify(body)} → 409 watch_revoked`, pr.status === 409 && pr.body?.error?.code === "watch_revoked", pr.body);
  }
  const rt = await v1(`/api/v1/deliveries/${x2After.at(-1).id}/retry`, { method: "POST" }, Y.key);
  check("R retry of canceled delivery → 409 watch_revoked", rt.status === 409 && rt.body?.error?.code === "watch_revoked", rt.body);

  // --- dashboard on the revoked watch
  const dr = await app("/api/cron/run", { method: "POST", json: { websiteId: x1.websiteId, targetId: x1.id } });
  const dp = await app(`/api/targets/${x1.id}`, { method: "PATCH", json: { enabled: true } });
  check("R dashboard Run now / edit on revoked watch → 409", dr.status === 409 && dp.status === 409, { dr: dr.status, dp: dp.status });
  const wp = await app(`/dashboard/websites/${x1.websiteId}`);
  const wj = await app(`/api/websites/${x1.websiteId}`);
  check("R dashboard still shows revoked watches and their alerts", wp.status === 200 && wj.body.targets.some((t: any) => t.id === x1.id) && wj.body.alerts.some((a: any) => a.targetId === x1.id));

  // --- website-wide "Run now" and the scheduled worker skip revoked watches only
  await resetLog();
  await setState({ pages: { [x1.url]: page(3), [x2.url]: page(3), [y1.url]: page(3), [dashUrl]: page(3) }, fail: { [x2.tok]: 200 } });
  const x1Checked = (await targetRow(x1.id)).lastCheckedAt;
  const runAll = await app("/api/cron/run", { method: "POST", json: { websiteId: x1.websiteId } });
  let log = await fakeLog();
  const scraped = (u: string) => log.some((e) => e.path === "/ctx/web/scrape/markdown" && e.query.url === u);
  check("R website Run now: Y and dashboard monitors checked, revoked X watches not scraped", runAll.status === 200 && scraped(y1.url) && scraped(dashUrl) && !scraped(x1.url) && !scraped(x2.url), runAll.body);
  check("R Y's event delivered (isolation)", log.some((e) => e.path === `/recv/${y1.tok}` && verifySig(e.headers["x-watcher-signature"], e.body, Y.secret)));
  check("R dashboard monitor still notifies its destination", log.some((e) => e.path === `/recv/${tokenOf(secrets.alertWebhookUrl)}`));

  await db.query(`UPDATE target SET "nextCheckDueAt" = now() - interval '1 hour' WHERE id = ANY($1)`, [[x1.id, x2.id, y1.id, dashId]]);
  await setState({ pages: { [x1.url]: page(4), [x2.url]: page(4), [y1.url]: page(4), [dashUrl]: page(4) } });
  await resetLog();
  const workerOut = execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
  writeFileSync(`${S}/worker-R.log`, workerOut);
  log = await fakeLog();
  check("R scheduled worker: revoked watches not checked (no scrape, lastCheckedAt unchanged)", !scraped(x1.url) && !scraped(x2.url) && String((await targetRow(x1.id)).lastCheckedAt) === String(x1Checked), { x1: x1Checked });
  check("R scheduled worker: Y and dashboard monitors still checked", scraped(y1.url) && scraped(dashUrl));
  check("R no new events or webhooks for revoked watches; canceled delivery never sent", (await alertCount(x1.id)) === x1AlertsBefore && !log.some((e) => e.path === `/recv/${x1.tok}` || e.path === `/recv/${x2.tok}`) && (await deliveries(x2.id)).at(-1)?.status === "canceled");

  // --- repeated and concurrent revocation
  const out2 = execFileSync("npm", ["run", "-s", "api-keys", "--", "revoke", X.id], { env: process.env, encoding: "utf8" });
  check("R revoking again: reports already revoked, revokedAt unchanged", /already revoked/.test(out2) && String(await revokedAtOf(X.id)) === String(revokedAt1), out2);
  const Z = await newClient("z");
  const z1 = await watchFor(Z, "z1");
  await setState({ pages: { [z1.url]: page(2) }, fail: { [z1.tok]: 500 } });
  await v1(`/api/v1/watches/${z1.id}/check`, { method: "POST" }, Z.key);
  const zs = await Promise.all(Array.from({ length: 5 }, () => revokeApiClient(Z.id)));
  const zTimes = new Set(zs.map((r) => (r.found ? r.revokedAt.toISOString() : "missing")));
  const zCanceled = zs.reduce((n, r) => n + (r.found ? r.canceledDeliveries : 0), 0);
  check("R 5 concurrent revocations: all succeed, one revokedAt, the pending delivery canceled exactly once",
    zs.every((r) => r.found) && zTimes.size === 1 && zs.filter((r) => r.found && !r.alreadyRevoked).length === 1 && zCanceled === 1 && (await deliveries(z1.id)).at(-1)?.status === "canceled", { zTimes: [...zTimes], zCanceled });

  // --- race: revocation while a check is in progress (scrape in flight)
  const W = await newClient("w");
  const w1 = await watchFor(W, "w1");
  const wAlerts = await alertCount(w1.id);
  await setState({ pages: { [w1.url]: page(2) }, delay: { [w1.url]: 2500 } });
  await resetLog();
  const inFlightCheck = v1(`/api/v1/watches/${w1.id}/check`, { method: "POST" }, W.key);
  for (let i = 0; i < 50 && !(await fakeLog()).some((e) => e.query?.url === w1.url); i++) await sleep(50);
  const wRevoke = await revokeApiClient(W.id);
  const wCheck = await inFlightCheck;
  await sleep(300);
  check("R race check↔revoke: revocation during the scrape → no event, no delivery, nothing sent",
    wRevoke.found && wCheck.status === 200 && wCheck.body.result.events === 0 && (await alertCount(w1.id)) === wAlerts && (await deliveries(w1.id)).length === 0 && !(await fakeLog()).some((e) => e.path === `/recv/${w1.tok}`), { check: wCheck.body?.result });

  // --- race: revocation while deliveries are in flight (one will fail, one succeed)
  const V = await newClient("v");
  const v1w = await watchFor(V, "vfail");
  const v2w = await watchFor(V, "vok");
  await setState({ pages: { [v1w.url]: page(2), [v2w.url]: page(2) }, fail: { [v1w.tok]: 500 }, delay: { [v1w.tok]: 2500, [v2w.tok]: 2500 } });
  await resetLog();
  const runV = app("/api/cron/run", { method: "POST", json: { websiteId: v1w.websiteId } });
  for (let i = 0; i < 100; i++) {
    const l = await fakeLog();
    if (l.some((e) => e.path === `/recv/${v1w.tok}`) && l.some((e) => e.path === `/recv/${v2w.tok}`)) break;
    await sleep(50);
  }
  const vRevoke = await revokeApiClient(V.id);
  await runV;
  const vFail = (await deliveries(v1w.id)).at(-1);
  const vOk = (await deliveries(v2w.id)).at(-1);
  check("R race delivery↔revoke: in-flight failure stays canceled (not requeued); in-flight success recorded delivered",
    vRevoke.found && vRevoke.canceledDeliveries === 2 && vFail?.status === "canceled" && vOk?.status === "delivered", { vRevoke, vFail, vOk });
  await setState({ fail: { [v1w.tok]: 200 }, delay: { [v1w.tok]: 0, [v2w.tok]: 0 } });
  await db.query(`UPDATE "webhookDelivery" SET "nextAttemptAt" = now() - interval '1 hour' WHERE "targetId" = $1`, [v1w.id]);
  await resetLog();
  execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
  check("R after the race the worker never re-sends the canceled delivery", !(await fakeLog()).some((e) => e.path === `/recv/${v1w.tok}`) && (await deliveries(v1w.id)).at(-1)?.status === "canceled");

  // --- isolation: Y is unaffected by all of the above
  const y2 = await watchFor(Y, "y2");
  await setState({ pages: { [y2.url]: page(2) } });
  await resetLog();
  const yc = await v1(`/api/v1/watches/${y2.id}/check`, { method: "POST" }, Y.key);
  const yEv = (await recvFor(y2.tok)).at(-1);
  check("R other API clients keep working end to end (create, check, signed event)", yc.status === 200 && yc.body.result.events === 1 && verifySig(yEv?.headers["x-watcher-signature"], yEv?.body, Y.secret), yc.body?.result);
  noLeak("R responses", yList.text + g.text + ev.text + dl.text + mc.text + rt.text + out1 + out2);
  save();
}

/* ================= PHASE L1/L2: API rate limits (Phase 4.4) ================= */
// The app runs twice (ports 3100 and 3101) on the same database, with tight limits:
// READ 20/1m, WRITE 5/1m, CREATE 3/1m,5/1d, CHECK 3/10s,7/1d, WEBHOOK 2/1m.
if (PHASE === "L1" || PHASE === "L2") {
  const { db: appDb } = await import("../src/lib/db");
  const schema = await import("../src/lib/db/schema");
  const { generateApiKey } = await import("../src/lib/api-keys");
  const APP2 = "http://localhost:3101";
  st.extraTokens ??= [];
  st.extraSecrets ??= [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function call(base: string, path: string, key: string, init: { method?: string; json?: unknown } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + path, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body, headers: res.headers, text };
  }
  async function newClient(name: string) {
    const k = generateApiKey();
    const id = `akey_${name}_${rnd()}`;
    const secret = `whsec_${randomBytes(32).toString("hex")}`;
    await appDb.insert(schema.apiClient).values({ id, ownerUserId: secrets.ids.user, name, keyPrefix: k.keyPrefix, keyHash: k.keyHash, webhookSecret: secret, createdAt: new Date() });
    st.extraSecrets.push(k.key, secret);
    return { id, key: k.key };
  }
  const rows = async (prefix: string) => (await db.query(`SELECT key, count, "windowStart", "expiresAt" FROM "apiRateLimit" WHERE starts_with(key, $1) ORDER BY key, "windowStart"`, [prefix])).rows;
  /** Fixed windows: start a burst early in a window so it cannot straddle a reset (needs `need` seconds). */
  async function earlyInWindow(windowSeconds: number, need: number) {
    const into = (Date.now() / 1000) % windowSeconds;
    if (windowSeconds - into < need) await sleep((windowSeconds - into + 0.3) * 1000);
  }
  const statuses = (rs: { status: number }[]) => rs.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

  if (PHASE === "L1") {
    // --- check: 3 per 10s, 7 per day
    const P = await newClient("p");
    const Q = await newClient("q");
    const url = `https://shop-l.example.com/p-${rnd()}`;
    await setState({ pages: { [url]: page(1) } });
    const created = await call(APP, "/api/v1/watches", P.key, { method: "POST", json: { url, type: "page" } });
    const wid = created.body?.watch?.id;
    const firstThree = [];
    await earlyInWindow(10, 6);
    for (let i = 0; i < 3; i++) firstThree.push(await call(APP, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" }));
    check("L below the limit: 3 checks in the 10s window succeed", created.status === 201 && firstThree.every((r) => r.status === 200), firstThree.map((r) => r.status));
    const over = await call(APP2, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" });
    const ra = Number(over.headers.get("retry-after"));
    const resetIn = (Date.parse(over.body?.error?.details?.resetAt) - Date.now()) / 1000;
    check("L crossing the limit → 429 rate_limited (from the other instance)", over.status === 429 && over.body?.error?.code === "rate_limited" && over.body.error.details.class === "check" && over.body.error.details.windowSeconds === 10, over.body);
    check("L Retry-After is the time to the window reset (1–10s, matches resetAt)", ra >= 1 && ra <= 10 && Math.abs(ra - resetIn) <= 1.5 && over.headers.get("ratelimit-remaining") === "0" && over.headers.get("ratelimit-limit") === "3" && over.headers.get("ratelimit-reset") === String(ra), { ra, resetIn });
    const qChecks = [];
    const qUrl = `https://shop-l.example.com/q-${rnd()}`;
    await setState({ pages: { [qUrl]: page(1) } });
    const qw = await call(APP, "/api/v1/watches", Q.key, { method: "POST", json: { url: qUrl, type: "page" } });
    for (let i = 0; i < 3; i++) qChecks.push(await call(APP, `/api/v1/watches/${qw.body.watch.id}/check`, Q.key, { method: "POST" }));
    check("L separate API clients have independent limits", qChecks.every((r) => r.status === 200), qChecks.map((r) => r.status));
    const readsWhileChecksLimited = await call(APP, "/api/v1/watches", P.key);
    check("L classes are independent: reads still allowed while checks are limited", readsWhileChecksLimited.status === 200);

    await sleep(ra * 1000 + 300);
    const after = [];
    for (let i = 0; i < 3; i++) after.push(await call(APP2, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" }));
    check("L window reset: after Retry-After, checks succeed again", after.every((r) => r.status === 200), after.map((r) => r.status));
    // 6 used today; the 10s window is full again. After it resets, 1 more is allowed (7/day), then the daily rule wins.
    await sleep(Number((await call(APP, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" })).headers.get("retry-after")) * 1000 + 300);
    const seventh = await call(APP, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" });
    const eighth = await call(APP, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" });
    const dayRa = Number(eighth.headers.get("retry-after"));
    const secondsToUtcMidnight = (Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000;
    check("L daily cap: the 8th check of the day → 429 with Retry-After until the daily window resets",
      seventh.status === 200 && eighth.status === 429 && eighth.body.error.details.windowSeconds === 86400 && Math.abs(dayRa - secondsToUtcMidnight) <= 2, { seventh: seventh.status, eighth: eighth.body?.error?.details, secondsToUtcMidnight });
    const pRows = await rows(`${P.id}:check:`);
    const tenS = pRows.filter((r) => r.key.endsWith(":10")).at(-1);
    const day = pRows.find((r) => r.key.endsWith(":86400"));
    check("L a denied request increments nothing (all rules in one transaction)", tenS?.count === 1 && day?.count === 7, pRows.map((r) => [r.key.split(":").slice(1).join(":"), r.count]));

    // --- concurrency across two instances: 30 parallel reads, limit 20
    const C = await newClient("c");
    await earlyInWindow(60, 20);
    const reads = await Promise.all(Array.from({ length: 30 }, (_, i) => call(i % 2 ? APP2 : APP, "/api/v1/watches?limit=1", C.key)));
    const readRows = await rows(`${C.id}:read:`);
    check("L concurrency: 30 parallel reads over 2 instances → exactly 20 allowed, 10× 429", statuses(reads)[200] === 20 && statuses(reads)[429] === 10 && readRows[0]?.count === 20, { s: statuses(reads), row: readRows[0]?.count });
    const D = await newClient("d");
    await setState({ pages: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`https://shop-l.example.com/d${i}`, page(i)])) });
    const creates = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i % 2 ? APP2 : APP, "/api/v1/watches", D.key, { method: "POST", json: { url: `https://shop-l.example.com/d${i}`, type: "page", baseline: false } })));
    const dWatches = Number((await db.query(`SELECT count(*) FROM target WHERE "apiClientId"=$1`, [D.id])).rows[0].count);
    check("L concurrency: 10 parallel creates (limit 3/min) → exactly 3 watches created", statuses(creates)[201] === 3 && statuses(creates)[429] === 7 && dWatches === 3, { s: statuses(creates), dWatches });

    // --- write and webhook classes
    const writes = [];
    await earlyInWindow(60, 20);
    for (let i = 0; i < 6; i++) writes.push(await call(APP, `/api/v1/watches/${wid}`, P.key, { method: "PATCH", json: { metadata: { n: i } } }));
    check("L write limit: 5 PATCHes allowed, the 6th → 429", writes.slice(0, 5).every((r) => r.status === 200) && writes[5]!.status === 429 && writes[5]!.body.error.details.class === "write", writes.map((r) => r.status));
    const tok = `l-wt-${rnd()}`;
    st.extraTokens.push(tok);
    const hooks = [];
    await earlyInWindow(60, 10);
    for (let i = 0; i < 3; i++) hooks.push(await call(APP, "/api/v1/webhooks/test", Q.key, { method: "POST", json: { url: `${FAKE}/recv/${tok}` } }));
    check("L webhook-test limit: 2 allowed, the 3rd → 429, and nothing is sent for it", hooks[0]!.status === 200 && hooks[1]!.status === 200 && hooks[2]!.status === 429 && (await recvFor(tok)).length === 2, hooks.map((r) => r.status));

    // --- revoked and invalid keys: still 401, never rate-limit state
    const before = (await rows(P.id)).length;
    execFileSync("npm", ["run", "-s", "api-keys", "--", "revoke", P.id], { env: process.env, encoding: "utf8" });
    const revokedCalls = await Promise.all([
      call(APP, "/api/v1/watches", P.key),
      call(APP, `/api/v1/watches/${wid}/check`, P.key, { method: "POST" }),
      call(APP2, `/api/v1/watches/${wid}`, P.key, { method: "PATCH", json: { metadata: {} } }),
    ]);
    check("L revoked key (even with exhausted limits) → 401 unauthorized, not 429", revokedCalls.every((r) => r.status === 401 && r.body?.error?.code === "unauthorized"), revokedCalls.map((r) => r.status));
    check("L revoked key requests create no rate-limit state", (await rows(P.id)).length === before);
    const bogus = await Promise.all(Array.from({ length: 5 }, () => call(APP, "/api/v1/watches", "wk_" + "x".repeat(40))));
    check("L invalid key → 401, no rate-limit rows", bogus.every((r) => r.status === 401) && Number((await db.query(`SELECT count(*) FROM "apiRateLimit" WHERE key NOT LIKE 'akey_%'`)).rows[0].count) === 0);

    // --- dashboard and other non-API paths are not rate limited
    await signIn();
    const dash = await Promise.all(Array.from({ length: 40 }, () => app("/api/user/notification-settings")));
    const run = await app("/api/cron/run", { method: "POST", json: { websiteId: qw.body.watch.websiteId } });
    const pageRes = await app("/dashboard");
    const health = await app("/api/health", { anon: true });
    check("L dashboard/session APIs, Run now, pages and health are never rate limited", dash.every((r) => r.status === 200) && run.status === 200 && pageRes.status === 200 && health.status === 200, { dash: statuses(dash), run: run.status });

    // --- restart: exhaust Q's writes, then the runner restarts instance 1 before L2
    const qWrites = [];
    await earlyInWindow(60, 50);
    for (let i = 0; i < 6; i++) qWrites.push(await call(APP, `/api/v1/watches/${qw.body.watch.id}`, Q.key, { method: "PATCH", json: { metadata: { i } } }));
    st.L = { Q, qWatch: qw.body.watch.id, exhaustedAt: Date.now() };
    check("L (restart setup) Q's write limit exhausted", qWrites[5]!.status === 429);
    save();
  }

  if (PHASE === "L2") {
    const { Q, qWatch, exhaustedAt } = st.L;
    const r = await call(APP, `/api/v1/watches/${qWatch}`, Q.key, { method: "PATCH", json: { metadata: { after: "restart" } } });
    check("L restart: limits survive restarting the app (still 429 on the restarted instance)", Date.now() - exhaustedAt < 55_000 && r.status === 429 && r.body.error.details.class === "write", { status: r.status, sinceMs: Date.now() - exhaustedAt });

    // --- cleanup: expired windows are deleted by the worker, current ones are kept
    for (let i = 0; i < 500; i++) {
      await db.query(`INSERT INTO "apiRateLimit" (key, "windowStart", count, "expiresAt") VALUES ($1, now() - interval '2 hours' - $2 * interval '1 minute', 1, now() - interval '1 hour' - $2 * interval '1 minute')`, [`akey_old_${i % 7}:read:60`, i]);
    }
    const total = async () => Number((await db.query(`SELECT count(*) FROM "apiRateLimit"`)).rows[0].count);
    const expired = async () => Number((await db.query(`SELECT count(*) FROM "apiRateLimit" WHERE "expiresAt" < now()`)).rows[0].count);
    const live = Number((await db.query(`SELECT count(*) FROM "apiRateLimit" WHERE "expiresAt" >= now()`)).rows[0].count);
    const before = await total();
    const out = execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
    writeFileSync(`${S}/worker-L.log`, out);
    const liveAfter = Number((await db.query(`SELECT count(*) FROM "apiRateLimit" WHERE "expiresAt" >= now()`)).rows[0].count);
    check("L cleanup: the worker deletes expired windows and keeps live ones", before >= 500 && (await expired()) === 0 && liveAfter === live && /pruned \d+ expired rate-limit window/.test(out), { before, live, liveAfter, after: await total() });
    const perClient = await db.query(`SELECT split_part(key, ':', 1) AS client, count(*) FROM "apiRateLimit" GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
    check("L storage is bounded: at most one live row per client × class × rule window", Number(perClient.rows[0]?.count ?? 0) <= 7, perClient.rows[0]);
    const after = await call(APP, `/api/v1/watches/${qWatch}`, Q.key);
    check("L reads for Q still work after cleanup (independent classes)", after.status === 200);
  }
}

/* ================= PHASE P: webhook delivery retention (Phase 4.5) ================= */
if (PHASE === "P") {
  const { encryptSecret } = await import("../src/lib/secret-box");
  const { pruneWebhookDeliveries } = await import("../src/lib/webhook-delivery-retention");
  const { spawn } = await import("node:child_process");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  st.extraTokens ??= [];
  // One valid ciphertext for every seeded row: pending rows must stay processable.
  const seedTok = `prune-${rnd()}`;
  st.extraTokens.push(seedTok);
  const encUrl = encryptSecret(`${FAKE}/recv/${seedTok}`, "webhookDelivery.url");
  const client = secrets.ids.apiClient;
  /** Insert `n` deliveries with id prefix, status, and SQL expressions for the timestamps. */
  async function seed(prefix: string, n: number, status: string, created: string, completed: string | null, nextAttempt = "now() + interval '30 days'") {
    await db.query(`
      INSERT INTO "webhookDelivery" (id, "eventId", "eventType", "apiClientId", url, payload, status, attempts, "nextAttemptAt", "createdAt", "completedAt")
      SELECT $1 || g, $1 || 'evt' || g, 'watch.triggered', $2, $3, '{}', $4, 1, ${nextAttempt}, ${created}, ${completed ?? "NULL"}
      FROM generate_series(1, $5) g`, [prefix, client, encUrl, status, n]);
  }
  // starts_with, not LIKE: "_" in the prefixes would be a LIKE wildcard ("whd_pr_" would match "whd_prec_…").
  const countLike = async (prefix: string) => Number((await db.query(`SELECT count(*) FROM "webhookDelivery" WHERE starts_with(id, $1)`, [prefix])).rows[0].count);
  const total = async () => Number((await db.query(`SELECT count(*) FROM "webhookDelivery"`)).rows[0].count);
  const runChild = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn("npx", ["tsx", "e2e/prune-child.mts", ...args], { env: process.env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("exit", (code) => resolve({ code, out }));
    });

  // --- semantics, one row per case
  await seed("whd_pd_", 1, "delivered", "now() - interval '40 days'", "now() - interval '31 days'");
  await seed("whd_pf_", 1, "failed", "now() - interval '40 days'", "now() - interval '31 days'");
  await seed("whd_pc_", 1, "canceled", "now() - interval '40 days'", "now() - interval '31 days'");
  await seed("whd_pp_", 1, "pending", "now() - interval '90 days'", null);
  await seed("whd_pr_", 1, "pending", "now() - interval '60 days'", null, "now() + interval '1 hour'");
  await db.query(`UPDATE "webhookDelivery" SET attempts = 5, "lastAttemptAt" = now() - interval '40 days', "lastStatusCode" = 503 WHERE starts_with(id, 'whd_pr_')`);
  await seed("whd_prec_", 1, "delivered", "now() - interval '60 days'", "now() - interval '20 hours'");
  await seed("whd_bin_", 1, "failed", "now() - interval '60 days'", "now() - interval '30 days' + interval '2 seconds'");
  await seed("whd_bout_", 1, "failed", "now() - interval '60 days'", "now() - interval '30 days' - interval '2 seconds'");
  const r1 = await pruneWebhookDeliveries(30);
  const left = Object.fromEntries(await Promise.all(["whd_pd_", "whd_pf_", "whd_pc_", "whd_pp_", "whd_pr_", "whd_prec_", "whd_bin_", "whd_bout_"].map(async (p) => [p, await countLike(p)])));
  check("P delivered / failed / canceled completed 31 days ago → deleted", left.whd_pd_ === 0 && left.whd_pf_ === 0 && left.whd_pc_ === 0, left);
  check("P pending created 90 days ago → kept", left.whd_pp_ === 1, left);
  check("P retrying delivery (5 attempts, last 40 days ago, still pending) → kept", left.whd_pr_ === 1, left);
  check("P created 60 days ago but completed 20 hours ago → kept (age is from completion)", left.whd_prec_ === 1, left);
  check("P boundary: completed 2s inside 30 days → kept; 2s past → deleted", left.whd_bin_ === 1 && left.whd_bout_ === 0, left);
  check("P a run reports what it deleted", r1.deleted === 4 && r1.complete, r1);
  await sleep(2500);
  const r1b = await pruneWebhookDeliveries(30);
  check("P boundary: the kept row is deleted once it crosses the cutoff (strictly older)", r1b.deleted === 1 && (await countLike("whd_bin_")) === 0, r1b);

  // --- batching a large backlog
  await seed("whd_big_", 25_000, "delivered", "now() - interval '100 days'", "now() - interval '35 days'");
  await seed("whd_bigkeep_", 2_000, "pending", "now() - interval '100 days'", null);
  const b1 = await pruneWebhookDeliveries(30, { batchSize: 1_000, maxBatches: 10 });
  check("P batching: a capped run deletes whole batches and stops (10 × 1000)", b1.deleted === 10_000 && b1.batches === 10 && !b1.complete && (await countLike("whd_big_")) === 15_000, b1);
  const t0 = Date.now();
  const b2 = await pruneWebhookDeliveries(30, { batchSize: 1_000 });
  check("P batching: the next run finishes the backlog; pending rows untouched", b2.deleted === 15_000 && b2.complete && (await countLike("whd_big_")) === 0 && (await countLike("whd_bigkeep_")) === 2_000, { ...b2, ms: Date.now() - t0 });
  // Whether the planner *prefers* the index depends on table statistics; what matters is that the
  // partial index matches the prune query, so check it is usable with the alternatives disabled.
  await db.query(`ANALYZE "webhookDelivery"`);
  await db.query("BEGIN");
  await db.query("SET LOCAL enable_seqscan = off");
  await db.query("SET LOCAL enable_bitmapscan = off");
  const plan = (await db.query(`EXPLAIN SELECT id FROM "webhookDelivery" WHERE "completedAt" IS NOT NULL AND "completedAt" < now() - interval '30 days' AND status IN ('delivered','failed','canceled') ORDER BY "completedAt" LIMIT 1000`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  await db.query("ROLLBACK");
  check("P the prune query can use the partial completedAt index", /Index Scan using webhook_delivery_completed_idx/.test(plan), plan);

  // --- interrupted run (SIGKILL mid-run), then re-run
  await seed("whd_int_", 30_000, "failed", "now() - interval '100 days'", "now() - interval '50 days'");
  const before = await total();
  // Small batches so the run lasts long enough to be killed partway through.
  // node itself (not the npx wrapper), so SIGKILL hits the process that is deleting.
  const child = spawn(process.execPath, ["--import", "tsx", "e2e/prune-child.mts", "30", "20", "100000"], { env: process.env });
  for (let i = 0; i < 200 && (await countLike("whd_int_")) === 30_000; i++) await sleep(25);
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  await sleep(500);
  const mid = await countLike("whd_int_");
  await sleep(1000);
  check("P the killed pruner is really gone (nothing deleted after the kill)", (await countLike("whd_int_")) === mid, { mid, later: await countLike("whd_int_") });
  const lostOther = before - (await total()) - (30_000 - mid);
  check("P interrupted (SIGKILL) mid-run: only eligible rows were deleted, in whole batches", mid > 0 && mid < 30_000 && (30_000 - mid) % 20 === 0 && lostOther === 0 && (await countLike("whd_bigkeep_")) === 2_000, { remaining: mid, lostOther });
  const again = await pruneWebhookDeliveries(30);
  check("P re-run after interruption completes the job", (await countLike("whd_int_")) === 0 && again.deleted === mid, again);

  // --- concurrent pruners (4 processes) on one backlog
  await seed("whd_conc_", 20_000, "canceled", "now() - interval '100 days'", "now() - interval '45 days'");
  const runs = await Promise.all(Array.from({ length: 4 }, () => runChild(["30", "500", "1000"])));
  const sum = runs.reduce((n, r) => n + (JSON.parse(r.out.trim().split("\n").at(-1) || "{}").deleted ?? 0), 0);
  check("P 4 concurrent pruners: no errors, every row deleted exactly once, nothing else touched",
    runs.every((r) => r.code === 0) && sum === 20_000 && (await countLike("whd_conc_")) === 0 && (await countLike("whd_bigkeep_")) === 2_000 && (await countLike("whd_pp_")) === 1, { sum, codes: runs.map((r) => r.code) });

  // --- active delivery: an in-flight delivery of a long-ago-created watch event is never pruned
  await signIn();
  const url = `https://shop-p.example.com/a-${rnd()}`;
  const tok = `pflight-${rnd()}`;
  st.extraTokens.push(tok);
  await setState({ pages: { [url]: page(1) }, delay: { [tok]: 2500 } });
  const w = await v1("/api/v1/watches", { method: "POST", json: { url, type: "page", callbackUrl: `${FAKE}/recv/${tok}` } });
  await setState({ pages: { [url]: page(2) } });
  const inFlight = v1(`/api/v1/watches/${w.body.watch.id}/check`, { method: "POST" });
  for (let i = 0; i < 100 && (await recvFor(tok)).length === 0; i++) await sleep(25);
  // Make the in-flight row look ancient, then prune aggressively while the request is open.
  await db.query(`UPDATE "webhookDelivery" SET "createdAt" = now() - interval '400 days', "lastAttemptAt" = now() - interval '400 days' WHERE "targetId" = $1`, [w.body.watch.id]);
  const during = await Promise.all([pruneWebhookDeliveries(2), pruneWebhookDeliveries(2)]);
  await inFlight;
  const row = (await db.query(`SELECT status, "completedAt" > now() - interval '1 minute' AS fresh FROM "webhookDelivery" WHERE "targetId" = $1`, [w.body.watch.id])).rows;
  check("P in-flight delivery (pending, claimed) survives pruning and completes as delivered with a fresh completedAt",
    row.length === 1 && row[0].status === "delivered" && row[0].fresh === true && during.every((d) => d.deleted === 0), { row, during });

  // --- retry vs prune race on an old failed delivery: either the retry wins (row kept) or the prune does (retry refused)
  await setState({ delay: { [tok]: 0 } });
  let raced = 0;
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `whd_race_${i}_${rnd()}`;
    await db.query(`INSERT INTO "webhookDelivery" (id,"eventId","eventType","targetId","apiClientId",url,payload,status,attempts,"nextAttemptAt","createdAt","completedAt","lastAttemptAt")
      VALUES ($1,$1,'watch.triggered',$2,$3,$4,'{}','failed',9,now(),now()-interval '80 days',now()-interval '40 days',now()-interval '40 days')`,
      [id, w.body.watch.id, client, encryptSecret(`${FAKE}/recv/${tok}`, "webhookDelivery.url")]);
    const [retry] = await Promise.all([v1(`/api/v1/deliveries/${id}/retry`, { method: "POST" }), pruneWebhookDeliveries(30)]);
    const exists = Number((await db.query(`SELECT count(*) FROM "webhookDelivery" WHERE id=$1`, [id])).rows[0].count) === 1;
    outcomes.push(`${retry.status}:${exists ? "kept" : "deleted"}`);
    if ((retry.status === 200 && exists) || (retry.status !== 200 && !exists)) raced += 1;
  }
  check("P retry↔prune race (10 trials): a 200 retry always keeps its row; a pruned row's retry is refused", raced === 10, outcomes);

  // --- worker: schedule, restart, disabled, invalid config
  await seed("whd_wk_", 50, "delivered", "now() - interval '100 days'", "now() - interval '35 days'");
  const work = (extra: Record<string, string>) => execFileSync("npm", ["run", "-s", "worker:once"], { env: { ...process.env, ...extra }, encoding: "utf8" });
  const off = work({ WEBHOOK_DELIVERY_RETENTION_DAYS: "off" });
  check("P retention off: the worker deletes nothing", (await countLike("whd_wk_")) === 50 && !/pruned \d+ webhook deliver/.test(off));
  const bad = execFileSync("sh", ["-c", "npm run -s worker:once 2>&1"], { env: { ...process.env, WEBHOOK_DELIVERY_RETENTION_DAYS: "thirty" }, encoding: "utf8" });
  check("P invalid setting: warns and uses the 30-day default", /using 30/.test(bad) && /pruned 50 webhook deliveries completed over 30 day/.test(bad) && (await countLike("whd_wk_")) === 0, bad.split("\n").filter((l) => /retention|pruned/.test(l)));
  await seed("whd_wk2_", 10, "failed", "now() - interval '100 days'", "now() - interval '8 days'");
  const w1 = work({ WEBHOOK_DELIVERY_RETENTION_DAYS: "7" });
  const w2 = work({ WEBHOOK_DELIVERY_RETENTION_DAYS: "7" });
  writeFileSync(`${S}/worker-P.log`, off + bad + w1 + w2);
  check("P worker restart: each fresh worker prunes on its first tick; a second run is a no-op", /pruned 10 webhook deliveries completed over 7 day/.test(w1) && !/pruned \d+ webhook deliver/.test(w2) && (await countLike("whd_wk2_")) === 0);
  check("P custom retention keeps newer rows (pending + 1-day-old kept with 7 days)", (await countLike("whd_pp_")) === 1 && (await countLike("whd_prec_")) === 1);
  save();
}

/* ================= PHASE Y: Retry-After on webhook retries (Phase 4.6) ================= */
if (PHASE === "Y") {
  st.extraTokens ??= [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const dbNow = async () => new Date((await db.query(`SELECT now() AS n`)).rows[0].n as Date);
  const imf = (d: Date) => d.toUTCString(); // "Thu, 01 Oct 2026 12:00:00 GMT" (IMF-fixdate)
  const asctime = (d: Date) => {
    const [wd, , mon] = d.toUTCString().split(" ");
    const day = String(d.getUTCDate()).padStart(2, " ");
    return `${wd!.slice(0, 3)} ${mon} ${day} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
  };
  /** A watch whose next event's first delivery gets `status` with `headers`; returns that delivery row. */
  async function firstAttempt(label: string, status: number, headers: Record<string, string>) {
    const url = `https://shop-y.example.com/${label}-${rnd()}`;
    const tok = `y-${label}-${rnd()}`;
    st.extraTokens.push(tok);
    await setState({ pages: { [url]: page(1) }, fail: { [tok]: status }, headers: { [tok]: headers } });
    const w = await v1("/api/v1/watches", { method: "POST", json: { url, type: "page", callbackUrl: `${FAKE}/recv/${tok}` } });
    await setState({ pages: { [url]: page(2) } });
    await v1(`/api/v1/watches/${w.body.watch.id}/check`, { method: "POST" });
    const row = (await db.query(
      `SELECT id, "eventId", status, attempts, "lastError", "completedAt",
              "nextAttemptAt", extract(epoch from ("nextAttemptAt" - "lastAttemptAt"))::float8 AS wait
       FROM "webhookDelivery" WHERE "targetId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [w.body.watch.id])).rows[0];
    return { ...row, tok, watchId: w.body.watch.id as string };
  }
  const backoff1 = (wait: number) => wait >= 27 && wait <= 33.5; // first backoff: 30s ±10%
  const near = (wait: number, s: number) => Math.abs(wait - s) <= 1.5;

  const r429 = await firstAttempt("s429", 429, { "Retry-After": "120" });
  check("Y 429 + Retry-After: 120 → waits 120s (longer than the 30s backoff)", r429.status === "pending" && near(r429.wait, 120) && /Retry-After: 120/.test(r429.lastError), r429);
  const r503 = await firstAttempt("s503", 503, { "Retry-After": "120" });
  check("Y 503 + Retry-After: 120 → waits 120s", r503.status === "pending" && near(r503.wait, 120), r503);
  const short = await firstAttempt("short", 429, { "Retry-After": "5" });
  check("Y Retry-After shorter than the backoff (5s) → normal backoff wins", backoff1(short.wait), short);
  const zero = await firstAttempt("zero", 503, { "Retry-After": "0" });
  check("Y Retry-After: 0 → normal backoff", backoff1(zero.wait), zero);

  const target = new Date(Math.floor((await dbNow()).getTime() / 1000) * 1000 + 600_000);
  const dImf = await firstAttempt("dimf", 503, { "Retry-After": imf(target) });
  check("Y HTTP-date (IMF-fixdate) 10 min ahead → next attempt exactly at that time", new Date(dImf.nextAttemptAt).getTime() === target.getTime(), { next: dImf.nextAttemptAt, target });
  const target2 = new Date(target.getTime() + 300_000);
  const dAsc = await firstAttempt("dasc", 429, { "Retry-After": asctime(target2) });
  check("Y HTTP-date (asctime form) → next attempt exactly at that time", new Date(dAsc.nextAttemptAt).getTime() === target2.getTime(), { next: dAsc.nextAttemptAt, target2, header: asctime(target2) });

  const big = await firstAttempt("big", 429, { "Retry-After": "86400" });
  check("Y Retry-After: 86400 (24h) → capped at 12h", near(big.wait, 43_200), big);
  const farDate = await firstAttempt("far", 503, { "Retry-After": imf(new Date((await dbNow()).getTime() + 2 * 86_400_000)) });
  check("Y HTTP-date 2 days ahead → capped at 12h", near(farDate.wait, 43_200), farDate);

  for (const [label, value] of [["malformed", "soon"], ["negative", "-60"], ["fraction", "1.5"], ["iso", new Date(Date.now() + 600_000).toISOString()]] as const) {
    const r = await firstAttempt(label, 429, { "Retry-After": value });
    check(`Y ${label} Retry-After (${value.slice(0, 24)}) → normal backoff, header not recorded as honored`, backoff1(r.wait) && !/Retry-After/.test(r.lastError), r);
  }
  const expired = await firstAttempt("expired", 503, { "Retry-After": imf(new Date((await dbNow()).getTime() - 86_400_000)) });
  check("Y expired HTTP-date (yesterday) → normal backoff", backoff1(expired.wait), expired);
  const none = await firstAttempt("none", 429, {});
  check("Y 429 without Retry-After → existing behavior (normal backoff)", backoff1(none.wait) && none.status === "pending", none);
  const s500 = await firstAttempt("s500", 500, { "Retry-After": "120" });
  check("Y 500 + Retry-After → not honored (only 429/503), normal backoff", backoff1(s500.wait) && !/Retry-After/.test(s500.lastError), s500);
  const gone = await firstAttempt("gone", 410, { "Retry-After": "120" });
  check("Y 410 + Retry-After → still fails immediately", gone.status === "failed" && gone.attempts === 1 && gone.completedAt !== null, gone);

  // Stable event id and attempt counting across the delayed retry.
  const first = (await recvFor(r429.tok)).at(-1);
  await setState({ fail: { [r429.tok]: 200 }, headers: { [r429.tok]: {} } });
  await db.query(`UPDATE "webhookDelivery" SET "nextAttemptAt" = now() WHERE id = $1`, [r429.id]);
  execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
  const second = (await recvFor(r429.tok)).at(-1);
  const after = (await db.query(`SELECT status, attempts, "eventId" FROM "webhookDelivery" WHERE id = $1`, [r429.id])).rows[0];
  check("Y delayed retry: same X-Watcher-Event-Id and body, attempt 2, signature verifies, delivered",
    first?.headers["x-watcher-event-id"] === r429.eventId && second?.headers["x-watcher-event-id"] === r429.eventId && second?.body === first?.body &&
    first?.headers["x-watcher-attempt"] === "1" && second?.headers["x-watcher-attempt"] === "2" && verifySig(second?.headers["x-watcher-signature"], second?.body, secrets.webhookSecret) &&
    after.status === "delivered" && after.attempts === 2, { after, ids: [first?.headers["x-watcher-event-id"], second?.headers["x-watcher-event-id"]] });

  // The attempt limit still ends retries: Retry-After cannot add an attempt.
  const last = await firstAttempt("limit", 429, { "Retry-After": "60" });
  await db.query(`UPDATE "webhookDelivery" SET attempts = 8, "nextAttemptAt" = now() WHERE id = $1`, [last.id]);
  execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
  const lastRow = (await db.query(`SELECT status, attempts, "completedAt" FROM "webhookDelivery" WHERE id = $1`, [last.id])).rows[0];
  check("Y on the 9th (last) attempt, 429 + Retry-After still ends as failed (no extra attempt)", lastRow.status === "failed" && lastRow.attempts === 9 && lastRow.completedAt !== null, lastRow);

  // Database clock: the deciding process runs with its clock 1 hour behind.
  const clk = await firstAttempt("clock", 503, { "Retry-After": "120" });
  await db.query(`UPDATE "webhookDelivery" SET "nextAttemptAt" = now() WHERE id = $1`, [clk.id]);
  const clkDate = new Date(Math.floor((await dbNow()).getTime() / 1000) * 1000 + 900_000);
  // Attempt 2's own backoff is 2m ±10% (≤132s), so ask for 300s to be sure Retry-After decides.
  await setState({ headers: { [clk.tok]: { "Retry-After": "300" } } });
  execFileSync(process.execPath, ["--import", "tsx", "e2e/retry-clock-child.mts", clk.id], { env: process.env, encoding: "utf8" });
  const c1 = (await db.query(`SELECT extract(epoch from ("nextAttemptAt" - now()))::float8 AS ahead FROM "webhookDelivery" WHERE id = $1`, [clk.id])).rows[0];
  await setState({ headers: { [clk.tok]: { "Retry-After": imf(clkDate) } } });
  await db.query(`UPDATE "webhookDelivery" SET "nextAttemptAt" = now() WHERE id = $1`, [clk.id]);
  execFileSync(process.execPath, ["--import", "tsx", "e2e/retry-clock-child.mts", clk.id], { env: process.env, encoding: "utf8" });
  const c2 = (await db.query(`SELECT "nextAttemptAt" FROM "webhookDelivery" WHERE id = $1`, [clk.id])).rows[0];
  check("Y database clock: with the app clock 1h behind, 300s means 300s from the DB's now, and a date lands exactly",
    c1.ahead > 295 && c1.ahead <= 301 && new Date(c2.nextAttemptAt).getTime() === clkDate.getTime(), { ahead: c1.ahead, next: c2.nextAttemptAt, clkDate });
  save();
}

/* ================= PHASE H: worker health (Phase 4.8) ================= */
if (PHASE === "H") {
  const { spawn } = await import("node:child_process");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const health = () => app("/api/health/worker", { anon: true });
  const rowsNow = async () => (await db.query(`SELECT loop, "lastStartedAt", "lastSuccessAt", "lastFailureAt", "dueBy" FROM "workerHeartbeat" ORDER BY loop`)).rows;
  const dbNow = async () => new Date((await db.query(`SELECT now() AS n`)).rows[0].n as Date).getTime();
  /** A real long-running worker process (node itself, so kill() stops it). */
  const startWorker = (extra: Record<string, string> = {}) => {
    const w = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      env: { ...process.env, SCRAPE_CRON: "* * * * *", WEBHOOK_POLL_SECONDS: "1", ...extra },
    });
    let out = "";
    w.stdout.on("data", (d) => (out += d));
    w.stderr.on("data", (d) => (out += d));
    return { w, log: () => out };
  };
  const stop = async (p: ReturnType<typeof startWorker>) => {
    p.w.kill("SIGKILL");
    await new Promise((r) => p.w.on("exit", r));
  };
  async function until(cond: () => Promise<boolean>, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return true;
      await sleep(200);
    }
    return false;
  }
  const loops = async () => (await health()).body?.loops ?? {};

  // --- never run (fresh state; earlier phases' runs are cleared for this phase)
  await db.query(`DELETE FROM "workerHeartbeat"`);
  const n0 = await health();
  check("H no heartbeat yet → 503, status never_run, both loops never_run",
    n0.status === 503 && n0.body.status === "never_run" && n0.body.loops.checks.status === "never_run" && n0.body.loops.webhooks.status === "never_run", n0.body);
  const web0 = await app("/api/health", { anon: true });
  check("H /api/health stays 200 while the worker has never run (independent)", web0.status === 200 && web0.body.ok === true);

  // --- one worker:once run → both healthy, deadlines from the worker's own cadence
  execFileSync("npm", ["run", "-s", "worker:once"], { env: { ...process.env, SCRAPE_CRON: "*/15 * * * *", WEBHOOK_POLL_SECONDS: "10" }, encoding: "utf8" });
  const h1 = await health();
  const now1 = await dbNow();
  const cDue = (Date.parse(h1.body.loops.checks.staleAfter) - now1) / 1000;
  const wDue = (Date.parse(h1.body.loops.webhooks.staleAfter) - now1) / 1000;
  check("H after a pass of each loop → 200 healthy, both loops healthy", h1.status === 200 && h1.body.status === "healthy" && h1.body.loops.checks.status === "healthy" && h1.body.loops.webhooks.status === "healthy", h1.body);
  check("H thresholds: checks = until next */15 run + 15 min grace; webhooks = 10s poll + 2 min grace",
    cDue > 15 * 60 - 5 && cDue <= 30 * 60 + 2 && wDue > 125 && wDue <= 131, { cDue, wDue });

  // --- one loop stale while the other is healthy (time passing simulated by moving the deadline back)
  await db.query(`UPDATE "workerHeartbeat" SET "dueBy" = now() - interval '1 second' WHERE loop = 'webhooks'`);
  const s1 = await health();
  check("H checks healthy, webhooks stale → 503 unhealthy, and the report says which",
    s1.status === 503 && s1.body.status === "unhealthy" && s1.body.loops.checks.status === "healthy" && s1.body.loops.webhooks.status === "stale", s1.body);
  execFileSync("npm", ["run", "-s", "worker:once"], { env: process.env, encoding: "utf8" });
  await db.query(`UPDATE "workerHeartbeat" SET "dueBy" = now() - interval '1 second' WHERE loop = 'checks'`);
  const s2 = await health();
  check("H webhooks healthy, checks stale → 503 unhealthy",
    s2.status === 503 && s2.body.loops.checks.status === "stale" && s2.body.loops.webhooks.status === "healthy", s2.body);
  await db.query(`UPDATE "workerHeartbeat" SET "dueBy" = now() - interval '1 second'`);
  const s3 = await health();
  check("H both stale → 503 unhealthy; /api/health still 200", s3.status === 503 && s3.body.status === "unhealthy" && (await app("/api/health", { anon: true })).status === 200, s3.body);

  // --- a real long-running worker recovers both loops; a pass in progress is visible
  const slowUrl = `https://shop-h.example.com/slow-${rnd()}`;
  await setState({ pages: { [slowUrl]: page(1) } });
  const sw = await v1("/api/v1/watches", { method: "POST", json: { url: slowUrl, type: "page" } });
  await db.query(`UPDATE target SET "nextCheckDueAt" = now() - interval '1 minute' WHERE id = $1`, [sw.body.watch.id]);
  await setState({ delay: { [slowUrl]: 4000 } });
  const w1 = startWorker();
  const sawRunning = await until(async () => Boolean((await loops()).checks?.runningSince));
  const recovered = await until(async () => (await health()).body?.status === "healthy");
  check("H a pass in progress is reported (checks.runningSince)", sawRunning);
  check("H restart/recovery: a new worker process brings both loops back to healthy", recovered, await loops());
  const beforeKill = await rowsNow();
  await stop(w1);
  await setState({ delay: { [slowUrl]: 0 } });
  await db.query(`UPDATE "workerHeartbeat" SET "dueBy" = now() - interval '1 second'`);
  check("H after the worker dies (deadline passed) → stale", (await health()).body.status === "unhealthy");
  const w2 = startWorker();
  const recovered2 = await until(async () => (await health()).body?.status === "healthy");
  await stop(w2);
  check("H worker restarted → healthy again", recovered2 && beforeKill.length === 2);

  // --- multiple worker instances: state stays 2 rows; timestamps never go backwards
  const workers = [startWorker(), startWorker(), startWorker()];
  const samples: number[] = [];
  let backwards = 0;
  const endAt = Date.now() + 8_000;
  while (Date.now() < endAt) {
    const r = (await db.query(`SELECT extract(epoch from "lastSuccessAt") * 1000 AS t FROM "workerHeartbeat" WHERE loop = 'webhooks'`)).rows[0];
    const t = Number(r?.t ?? 0);
    if (samples.length && t < samples.at(-1)!) backwards += 1;
    samples.push(t);
    await sleep(150);
  }
  const rowCount = Number((await db.query(`SELECT count(*) FROM "workerHeartbeat"`)).rows[0].count);
  const hm = await health();
  for (const w of workers) await stop(w);
  const errs = workers.map((w) => w.log()).join("\n").split("\n").filter((l) => /could not record heartbeat|fatal|deadlock/i.test(l));
  check("H 3 concurrent workers: exactly 2 heartbeat rows, timestamps never move backwards, healthy, no write errors",
    rowCount === 2 && backwards === 0 && hm.body.status === "healthy" && errs.length === 0 && new Set(samples).size > 3, { rowCount, backwards, distinct: new Set(samples).size, errs });
  const writes = Number((await db.query(`SELECT n_tup_upd + n_tup_ins AS w FROM pg_stat_user_tables WHERE relname = 'workerHeartbeat'`)).rows[0]?.w ?? 0);
  check("H bounded: many passes (hundreds of heartbeat writes) still leave 2 rows", rowCount === 2 && writes > 20, { writes });

  // --- database clock
  await db.query(`UPDATE "workerHeartbeat" SET "dueBy" = now() + interval '30 seconds', "lastSuccessAt" = now()`);
  const fwd = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "e2e/health-clock-child.mts", String(3_600_000)], { env: process.env, encoding: "utf8" }).trim().split("\n").at(-1)!);
  check("H status uses the database clock: a reader whose clock is 1h ahead still sees healthy", fwd.status === "healthy", fwd);
  await db.query(`UPDATE "workerHeartbeat" SET "dueBy" = now() - interval '1 second' WHERE loop = 'webhooks'`);
  const back = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "e2e/health-clock-child.mts", String(-3_600_000), "write"], { env: process.env, encoding: "utf8" }).trim().split("\n").at(-1)!);
  const wrow = (await db.query(`SELECT extract(epoch from (now() - "lastSuccessAt")) AS age, extract(epoch from ("dueBy" - now())) AS due FROM "workerHeartbeat" WHERE loop = 'webhooks'`)).rows[0];
  check("H heartbeats are written with the database clock: a writer whose clock is 1h behind records now, due ~130s ahead",
    back.loops.webhooks.status === "healthy" && Number(wrow.age) < 5 && Number(wrow.due) > 120 && Number(wrow.due) <= 131, { wrow, back: back.loops.webhooks });

  // --- no leaks
  const body = (await health()).text;
  const keys = JSON.stringify(Object.keys(JSON.parse(body)).sort()) + JSON.stringify(Object.keys(JSON.parse(body).loops.checks).sort());
  check("H response contains only statuses and timestamps",
    keys === '["checkedAt","loops","status"]["lastPassFailed","lastSuccessAt","runningSince","secondsSinceSuccess","staleAfter","status"]' && !/https?:|postgres|localhost|127\.0\.0\.1|akey_|whsec_|enc:v1/.test(body), { keys, body: body.slice(0, 300) });
  noLeak("H worker health response", body);
  check("H response is not cacheable", (await health()).res.headers.get("cache-control") === "no-store");
  save();
}

/* ================= PHASE S: invite-only accounts, authorization, auth limits (final security) ================= */
if (PHASE === "S") {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let ipSeq = 10;
  const nextIp = () => `198.51.100.${ipSeq++}`; // TEST-NET-2: one per request so Better Auth's per-IP limiter stays out of the way
  async function authPost(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${APP}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, "x-forwarded-for": nextIp(), ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body: json, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), setCookie: r.headers.getSetCookie() };
  }
  async function as(cookieJar: string, path: string, init: { method?: string; json?: unknown; extraCookie?: string } = {}) {
    const headers: Record<string, string> = { origin: APP, cookie: init.extraCookie ? `${cookieJar}; ${init.extraCookie}` : cookieJar };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(APP + path, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json), redirect: "manual" });
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body, text };
  }
  const userCount = async () => Number((await db.query(`SELECT count(*) FROM "user"`)).rows[0].count);
  const inviteRow = async (token: string) => (await db.query(`SELECT "useCount", "maxUses", "redeemedByUserId" FROM "accountInvite" WHERE "tokenHash" = encode(sha256($1::bytea), 'hex')`, [token])).rows[0];
  const signUp = (email: string, invite?: string, extra: Record<string, unknown> = {}) =>
    authPost("/sign-up/email", { name: "Test Person", email, password: "test-only-password-1", ...extra }, invite ? { "x-webdog-invite": invite } : {});

  // Owner A (seeded) creates invites through the API.
  const owner = await authPost("/sign-in/email", { email: secrets.email, password: secrets.password });
  check("S existing account signs in normally", owner.status === 200 && owner.cookie.includes("session_token"), owner.status);
  const newInvite = async () => {
    const r = await as(owner.cookie, "/api/account/invites", { method: "POST" });
    return decodeURIComponent(String(r.body?.inviteUrl ?? "").split("/invite/")[1] ?? "");
  };

  // --- no public sign-up
  const before = await userCount();
  const noInvite = await signUp(`nobody-${rnd()}@example.com`);
  check("S sign-up without an invite → 403 invite-only, no user created", noInvite.status === 403 && /invite-only/.test(noInvite.body?.message ?? "") && (await userCount()) === before, noInvite);
  const bogus = await signUp(`bogus-${rnd()}@example.com`, "not-a-real-invite-token-0000000000");
  check("S sign-up with a made-up invite → 403, no user created", bogus.status === 403 && (await userCount()) === before, bogus.body);
  const bodyOnly = await signUp(`body-${rnd()}@example.com`, undefined, { invite: await newInvite(), inviteToken: "x" });
  check("S an invite in the request body (not the header) doesn't count → refused, no user created", bodyOnly.status >= 400 && bodyOnly.status < 500 && (await userCount()) === before, bodyOnly);
  const expiredTok = await newInvite();
  await db.query(`UPDATE "accountInvite" SET "expiresAt" = now() - interval '1 minute' WHERE "tokenHash" = encode(sha256($1::bytea), 'hex')`, [expiredTok]);
  const expired = await signUp(`expired-${rnd()}@example.com`, expiredTok);
  check("S sign-up with an expired invite → 403", expired.status === 403 && (await userCount()) === before, expired.body);
  const usedTok = await newInvite();
  await db.query(`UPDATE "accountInvite" SET "useCount" = "maxUses" WHERE "tokenHash" = encode(sha256($1::bytea), 'hex')`, [usedTok]);
  const used = await signUp(`used-${rnd()}@example.com`, usedTok);
  check("S sign-up with a used-up invite → 403", used.status === 403 && (await userCount()) === before, used.body);
  const social = await authPost("/sign-in/social", { provider: "github", callbackURL: "/dashboard" });
  check("S no social/OAuth sign-in exists to create accounts", social.status >= 400 && (await userCount()) === before, social.status);

  // --- invited sign-up: account created, joins the inviting account, consumes one use
  const memberTok = await newInvite();
  const mEmail = `member-${rnd()}@example.com`;
  const m = await signUp(mEmail, memberTok);
  const mId = m.body?.user?.id;
  const mem = (await db.query(`SELECT count(*) FROM "accountMembership" WHERE "ownerUserId" = $1 AND "memberUserId" = $2`, [secrets.ids.user, mId])).rows[0].count;
  const inv1 = await inviteRow(memberTok);
  check("S sign-up with a valid invite → account created, member of the inviting account, one use consumed",
    m.status === 200 && mId && mem === "1" && inv1.useCount === 1 && inv1.redeemedByUserId === mId, { status: m.status, mem, inv1 });
  const redeem = await as(m.cookie, "/api/account/invites/redeem", { method: "POST", json: { token: memberTok } });
  check("S the invite page's redeem step afterwards consumes nothing more", redeem.status === 200 && (await inviteRow(memberTok)).useCount === 1, { redeem: redeem.body, inv: await inviteRow(memberTok) });
  const intro = (await db.query(`SELECT "contextIntroDismissedAt" IS NOT NULL AS skipped FROM "user" WHERE id = $1`, [mId])).rows[0];
  check("S invited members skip the owner onboarding, as before", intro.skipped === true);

  // --- concurrent sign-ups on one remaining use: exactly one account
  const raceTok = await newInvite();
  await db.query(`UPDATE "accountInvite" SET "maxUses" = 1 WHERE "tokenHash" = encode(sha256($1::bytea), 'hex')`, [raceTok]);
  const beforeRace = await userCount();
  const race = await Promise.all(Array.from({ length: 8 }, () => signUp(`race-${rnd()}@example.com`, raceTok)));
  const ok = race.filter((r) => r.status === 200).length;
  check("S 8 concurrent sign-ups on an invite with 1 use left → exactly 1 account, 7× 403",
    ok === 1 && race.filter((r) => r.status === 403).length === 7 && (await userCount()) === beforeRace + 1 && (await inviteRow(raceTok)).useCount === 1, race.map((r) => r.status));

  // --- operator bootstrap CLI (no invite) and the outsider it creates
  const xEmail = `outsider-${rnd()}@example.com`;
  const cli = execFileSync("sh", ["-c", `printf '%s' 'test-only-password-2' | npm run -s users -- create --email ${xEmail} --name Outsider --password-stdin`], { env: process.env, encoding: "utf8" });
  const x = await authPost("/sign-in/email", { email: xEmail, password: "test-only-password-2" });
  check("S operator CLI creates a user without an invite; it can sign in", /Created user/.test(cli) && x.status === 200 && !/test-only-password-2/.test(cli), { cli, status: x.status });

  // --- cross-account access: the outsider sees none of A's data
  const site = secrets.ids.website;
  const aTarget = secrets.ids.target;
  const aAlert = (await db.query(`SELECT id FROM alert WHERE "websiteId" = $1 LIMIT 1`, [site])).rows[0]?.id ?? "alr_none";
  const forged = `wd_account=${secrets.ids.user}`;
  const outsiderCalls = await Promise.all([
    as(x.cookie, `/api/websites/${site}`),
    as(x.cookie, `/api/websites/${site}`, { method: "PATCH", json: { notificationDestinationIds: null } }),
    as(x.cookie, `/api/websites/${site}`, { method: "DELETE" }),
    as(x.cookie, `/api/websites/${site}/share`, { method: "POST" }),
    as(x.cookie, `/api/targets/${aTarget}`, { method: "PATCH", json: { aiTriageEnabled: true } }),
    as(x.cookie, `/api/targets/${aTarget}`, { method: "DELETE" }),
    as(x.cookie, `/api/alerts/${aAlert}`, { method: "PATCH", json: { read: true } }),
    as(x.cookie, `/api/cron/run`, { method: "POST", json: { websiteId: site } }),
    as(x.cookie, `/api/user/notification-destinations/${secrets.ids.hook}`, { method: "PATCH", json: { name: "pwned" } }),
    as(x.cookie, `/api/user/notification-settings/test`, { method: "POST", json: { destinationId: secrets.ids.hook } }),
    as(x.cookie, `/api/websites/${site}`, { extraCookie: forged }),
    as(x.cookie, `/api/targets/${aTarget}`, { method: "PATCH", json: { aiTriageEnabled: true }, extraCookie: forged }),
  ]);
  check("S outsider: every read/write/trigger on another account's site, monitor, alert, destination → 404/400 (incl. forged account cookie)",
    outsiderCalls.every((r) => r.status === 404 || r.status === 400), outsiderCalls.map((r) => r.status));
  const lists = await Promise.all([as(x.cookie, "/api/websites"), as(x.cookie, "/api/alerts"), as(x.cookie, "/api/user/notification-destinations"), as(x.cookie, "/api/user/notification-settings")]);
  const leaked = [site, aTarget, secrets.ids.hook, secrets.ids.slack, "Legacy Shop"].filter((n) => lists.some((l) => l.text.includes(n)));
  check("S outsider: lists of websites, alerts, destinations, settings contain nothing of the other account", leaked.length === 0, leaked);
  const page = await as(x.cookie, `/dashboard/websites/${site}`);
  check("S outsider: another account's dashboard page is not served", page.status === 404 || !page.text.includes("Legacy Shop"), page.status);
  const sw = await as(x.cookie, "/api/account/active", { method: "POST", json: { ownerUserId: secrets.ids.user } });
  check("S outsider cannot switch into another account", sw.status === 400, sw.body);
  check("S outsider: no team management of another account", (await as(x.cookie, `/api/account/members/${mId}`, { method: "DELETE" })).status === 404);

  // --- member: full use of the account it joined, no team administration
  const mSites = await as(m.cookie, "/api/websites");
  const mSite = await as(m.cookie, `/api/websites/${site}`);
  check("S member: reads the account it joined", mSites.text.includes(site) && mSite.status === 200);
  const mInv = await as(m.cookie, "/api/account/invites");
  const mInvPost = await as(m.cookie, "/api/account/invites", { method: "POST" });
  const mKick = await as(m.cookie, `/api/account/members/${mId}`, { method: "DELETE" });
  check("S member: cannot list or create invites, or remove members (owner-only)", mInv.status === 403 && mInvPost.status === 403 && mKick.status === 404, [mInv.status, mInvPost.status, mKick.status]);
  check("S member: no access to the outsider's account", (await as(m.cookie, "/api/account/active", { method: "POST", json: { ownerUserId: x.body?.user?.id } })).status === 400);

  // --- session cookie flags (http here; the https/Secure variant runs in run.sh)
  const sc = owner.setCookie.find((c) => /session_token=/.test(c)) ?? "";
  check("S session cookie: HttpOnly, SameSite=Lax, Path=/, expiring", /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && /(Max-Age|Expires)=/i.test(sc), sc.replace(/=[^;]+/, "=…"));

  // --- Better Auth brute-force limit: 3 sign-in attempts per 10 s per client IP
  await sleep(11_000);
  const attempt = (ip: string) => fetch(`${APP}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: APP, "x-forwarded-for": ip },
    body: JSON.stringify({ email: secrets.email, password: "wrong-password-0" }),
  });
  const sameIp = [];
  for (let i = 0; i < 4; i++) sameIp.push(await attempt("203.0.113.77"));
  const other = await attempt("203.0.113.78");
  check("S brute force: 4th wrong-password attempt within 10 s from one IP → 429; another IP is independent",
    sameIp.slice(0, 3).every((r) => r.status === 401) && sameIp[3]!.status === 429 && other.status === 401, [...sameIp.map((r) => r.status), other.status]);
  const noIp = [];
  for (let i = 0; i < 4; i++) noIp.push((await fetch(`${APP}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify({ email: secrets.email, password: "wrong-password-0" }) })).status);
  check("S without a usable client IP, attempts share one bucket (still limited: 4th → 429)", noIp.slice(0, 3).every((s) => s === 401) && noIp[3] === 429, noIp);
  await sleep(11_000); // leave the limiter clear for later phases
  save();
}

/* ---------------- summary ---------------- */
const all = existsSync(`${S}/results.json`) ? JSON.parse(readFileSync(`${S}/results.json`, "utf8")) : [];
writeFileSync(`${S}/results.json`, JSON.stringify([...all.filter((r: any) => r.phase !== PHASE), ...results], null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n[${PHASE}] ${results.length - failed.length}/${results.length} passed`);
await db.end();
process.exit(failed.length ? 1 : 0);
