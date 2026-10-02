// Phase 4.7: legacy API webhook destination cleanup, against a database that lived through
// the pre-signed-webhooks API (schema 0005), then real migrations 0006–0010.
import pg from "pg";
import { migrationsUpTo } from "./migrations-upto.mjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const S = process.env.E2E_DIR!;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: ok ? undefined : JSON.stringify(detail)?.slice(0, 500) });
  console.log(`${ok ? "PASS" : "FAIL"} [G] ${name}${ok ? "" : `  -> ${JSON.stringify(detail)?.slice(0, 500)}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(6).toString("hex");
const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
const cli = (args: string[] = []) => execFileSync("npm", ["run", "-s", "legacy-webhooks", "--", ...args], { env: process.env, encoding: "utf8" });

// --- 1. Database as the Phase 1/2 code left it (schema through 0005, plaintext URLs)
await migrate(drizzle(c), { migrationsFolder: migrationsUpTo(5, `${S}/migrations-upto-5`) });
const T = (min: number) => new Date(Date.UTC(2026, 8, 20, 12, min)); // fixed past instants
async function user(id: string) {
  await q(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1 || '@example.com',true,$2,$2)`, [id, T(0)]);
}
async function apiKey(id: string, owner: string, at: Date) {
  await q(`INSERT INTO "apiClient" (id,"ownerUserId",name,"keyPrefix","keyHash","createdAt") VALUES ($1,$2,'k',$3,$4,$5)`,
    [id, owner, `wk_${rnd()}`, createHash("sha256").update(rnd()).digest("hex"), at]);
}
/** A destination exactly as findOrCreateWebhookDestination wrote it (createdAt = updatedAt). */
async function dest(id: string, owner: string, name: string, url: string, at: Date, updatedAt: Date = at) {
  await q(`INSERT INTO "notificationDestination" (id,"userId",channel,name,"alertWebhookUrl","createdAt","updatedAt") VALUES ($1,$2,'WEBHOOK',$3,$4,$5,$6)`, [id, owner, name, url, at, updatedAt]);
}
async function site(id: string, owner: string, domain: string, destIds: string[] | null = null) {
  await q(`INSERT INTO website (id,"userId",name,url,domain,"notificationDestinationIds","createdAt") VALUES ($1,$2,$3,$4,$3,$5,$6)`,
    [id, owner, domain, `https://${domain}`, destIds ? JSON.stringify(destIds) : null, T(0)]);
}
async function target(id: string, siteId: string, apiClientId: string | null, destId: string | null) {
  await q(`INSERT INTO target (id,"websiteId",kind,"pageUrl",enabled,"checkIntervalHours","apiClientId","externalNotify","notificationDestinationId","createdAt") VALUES ($1,$2,'PAGE_CONTENT',$3,true,24,$4,$5,$6,$7)`,
    [id, siteId, `https://x.test/${id}`, apiClientId, destId !== null, destId, T(5)]);
}
await user("u_api"); await user("u_nokey"); await user("u_latekey");
await apiKey("akey_1", "u_api", T(1));
await apiKey("akey_late", "u_latekey", T(50)); // created after its "legacy" destination
await site("web_api", "u_api", "shop.test");

// Legacy artifacts, each attached to an API watch (0006 will detach them).
await dest("ndst_L1", "u_api", "API webhook (h1.test)", "https://h1.test/in/tok-L1", T(10));
await target("tgt_L1", "web_api", "akey_1", "ndst_L1");
await dest("ndst_L2", "u_api", "API webhook (h2.test)", "https://h2.test/in/tok-L2", T(11));
await target("tgt_L2", "web_api", "akey_1", "ndst_L2");
await target("tgt_L2_dash", "web_api", null, "ndst_L2"); // a dashboard monitor also uses it
await dest("ndst_L3", "u_api", "API webhook (h3.test)", "https://h3.test/in/tok-L3", T(12));
await target("tgt_L3", "web_api", "akey_1", "ndst_L3");
await q(`UPDATE website SET "notificationDestinationIds" = $1 WHERE id = 'web_api'`, [JSON.stringify(["ndst_L3"])]); // selected on a website
await dest("ndst_L4", "u_api", "API webhook (h4.test)", "https://h4.test/in/tok-L4", T(13), T(40)); // edited later in the dashboard
await target("tgt_L4", "web_api", "akey_1", "ndst_L4");
await dest("ndst_L5", "u_api", "API webhook (h5.test)", "https://elsewhere.test/in/tok-L5", T(14)); // name/host mismatch
await dest("ndst_L6", "u_nokey", "API webhook (h6.test)", "https://h6.test/in/tok-L6", T(15)); // account never had an API key
await dest("ndst_L7", "u_api", "API webhook (h7.test:8443)", "https://h7.test:8443/in/tok-L7", T(16)); // its API watch was deleted since
await dest("ndst_L8", "u_latekey", "API webhook (h8.test)", "https://h8.test/in/tok-L8", T(17)); // key created after it
// Normal / similar-but-unrelated destinations.
await dest("ndst_D1", "u_api", "Ops webhook", "https://ops.test/hook/tok-D1", T(2));
await dest("ndst_D2", "u_api", "Partner hook", "https://partner.test/in/tok-D2", T(3)); // reused by the old API for tgt_D2
await target("tgt_D2", "web_api", "akey_1", "ndst_D2");
await dest("ndst_S1", "u_api", "API webhook", "https://s1.test/in/tok-S1", T(4));
await dest("ndst_S2", "u_api", "Partner API webhook (s2.test)", "https://s2.test/in/tok-S2", T(4));
await dest("ndst_S3", "u_api", "api webhook (s3.test)", "https://s3.test/in/tok-S3", T(4));
await q(`INSERT INTO "notificationDestination" (id,"userId",channel,name,"slackWebhookUrl","createdAt","updatedAt") VALUES ('ndst_S4','u_api','SLACK','API webhook (hooks.slack.com)','https://hooks.slack.com/services/T/B/tok-S4',$1,$1)`, [T(4)]);
// History that must survive.
await q(`INSERT INTO alert (id,"websiteId","targetId",kind,title,details,"createdAt") SELECT 'alr_' || g, 'web_api', 'tgt_L1', 'PAGE_CONTENT', 'change ' || g, '{}', $1 FROM generate_series(1,25) g`, [T(20)]);
// A bulk of plain legacy leftovers for the interruption test.
for (let i = 0; i < 1500; i++) await dest(`ndst_bulk_${String(i).padStart(4, "0")}`, "u_api", `API webhook (b${i}.test)`, `https://b${i}.test/in/tok-bulk`, T(18));

// --- 2. Real migrations (0006 detach + 0007 encrypt + 0008–0010)
const mig = execFileSync("npm", ["run", "-s", "db:migrate:deploy"], { env: process.env, encoding: "utf8" });
const moved = (await q(`SELECT id, "notificationDestinationId", "externalNotify", "callbackUrl" LIKE 'enc:v1:%' AS enc FROM target WHERE "apiClientId" IS NOT NULL ORDER BY id`)).rows;
check("migrations 0006 and later applied; API watches detached from their destinations, callback URLs moved and encrypted",
  /applied [5-9] migration/.test(mig) && moved.every((t) => t.notificationDestinationId === null && t.externalNotify === false && t.enc === true), { mig: mig.split("\n").slice(0, 4), moved });
const encAll = (await q(`SELECT count(*) FILTER (WHERE "alertWebhookUrl" LIKE 'enc:v1:%' OR "slackWebhookUrl" LIKE 'enc:v1:%') AS enc, count(*) AS n FROM "notificationDestination"`)).rows[0];
check("destination URLs are encrypted at rest", Number(encAll.enc) === Number(encAll.n), encAll);

const snapshot = async () => ({
  dests: (await q(`SELECT id, name, "alertWebhookUrl", "slackWebhookUrl", "updatedAt" FROM "notificationDestination" WHERE NOT starts_with(id, 'ndst_bulk_') ORDER BY id`)).rows,
  alerts: Number((await q(`SELECT count(*) FROM alert`)).rows[0].count),
  targets: (await q(`SELECT id, "notificationDestinationId", "callbackUrl" FROM target ORDER BY id`)).rows,
  sites: (await q(`SELECT id, "notificationDestinationIds" FROM website ORDER BY id`)).rows,
  bulk: Number((await q(`SELECT count(*) FROM "notificationDestination" WHERE starts_with(id, 'ndst_bulk_')`)).rows[0].count),
});
const before = await snapshot();

// --- 3. Dry run: reports, changes nothing
const dry = cli();
const line = (id: string) => dry.split("\n").find((l) => l.includes(` ${id} `)) ?? "";
check("dry run changes nothing", JSON.stringify(await snapshot()) === JSON.stringify(before));
check("dry run: unreferenced legacy destinations would be removed (incl. one whose watch was deleted)",
  /^would remove/.test(line("ndst_L1")) && /^would remove/.test(line("ndst_L7")) && /1502 would be removed/.test(dry), { L1: line("ndst_L1"), L7: line("ndst_L7"), tail: dry.trim().split("\n").at(-1) });
const expectKept: [string, RegExp][] = [
  ["ndst_L2", /^kept.*used by 1 monitor/],
  ["ndst_L3", /^kept.*selected on 1 website/],
  ["ndst_L4", /^kept.*edited after/],
  ["ndst_L5", /^kept.*does not match/],
  ["ndst_L6", /^kept.*no API key/],
  ["ndst_L8", /^kept.*no API key/],
];
check("dry run: legacy-looking destinations in use, edited, mismatched, or from accounts without a key are kept, with the reason",
  expectKept.every(([id, re]) => re.test(line(id))), expectKept.map(([id]) => line(id)));
check("dry run: normal and similar-but-unrelated destinations are not even listed",
  ["ndst_D1", "ndst_D2", "ndst_S1", "ndst_S2", "ndst_S3", "ndst_S4"].every((id) => line(id) === ""));
check("output never contains a webhook URL or token", !/https?:\/\/|tok-/.test(dry));

// --- 4. A monitor starts using a candidate while the cleanup waits on it: kept
const race = new pg.Client({ connectionString: process.env.DATABASE_URL });
await race.connect();
await race.query("BEGIN");
await race.query(`UPDATE target SET "notificationDestinationId" = 'ndst_bulk_0000', "externalNotify" = true WHERE id = 'tgt_D2'`); // FK key-share lock on the destination
const applyRace = spawn(process.execPath, ["--import", "tsx", "scripts/legacy-webhooks.ts", "--apply"], { env: process.env });
let raceOut = "";
applyRace.stdout.on("data", (d) => (raceOut += d));
// Wait until the cleanup is actually blocked on that destination's row lock, then commit.
let blocked = false;
for (let i = 0; i < 200 && !blocked; i++) {
  blocked = Number((await q(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) > 0;
  if (!blocked) await sleep(50);
}
check("race setup: the cleanup is waiting on the destination's row lock", blocked);
await race.query("COMMIT");
await race.end();
// Let it get partway, then kill it (interruption).
for (let i = 0; i < 400; i++) {
  const n = Number((await q(`SELECT count(*) FROM "notificationDestination" WHERE starts_with(id, 'ndst_bulk_')`)).rows[0].count);
  if (n < 1400) break;
  await sleep(25);
}
applyRace.kill("SIGKILL");
await new Promise((r) => applyRace.on("exit", r));
const mid = await snapshot();
check("race: a destination that became used while the cleanup waited on its lock is kept",
  (await q(`SELECT count(*) FROM "notificationDestination" WHERE id = 'ndst_bulk_0000'`)).rows[0].count === "1", { raceOut: raceOut.split("\n").find((l) => l.includes("ndst_bulk_0000")) });
check("interrupted (SIGKILL) partway: some removed, nothing that must be kept was touched",
  mid.bulk > 1 && mid.bulk < 1500 && JSON.stringify(mid.dests.filter((d) => d.id !== "ndst_L1" && d.id !== "ndst_L7")) === JSON.stringify(before.dests.filter((d) => d.id !== "ndst_L1" && d.id !== "ndst_L7")) && mid.alerts === before.alerts, { bulkLeft: mid.bulk });

// --- 5. Resume, then run again
const apply1 = cli(["--apply"]);
const after = await snapshot();
const keptIds = after.dests.map((d) => d.id);
check("re-run after the interruption finishes: L1, L7 and every bulk leftover removed (except the one now in use)",
  !keptIds.includes("ndst_L1") && !keptIds.includes("ndst_L7") && after.bulk === 1 && /Removed \d+; kept 7\./.test(apply1), { bulk: after.bulk, tail: apply1.trim().split("\n").at(-1) });
check("kept: in-use, website-selected, edited, mismatched, no-key, normal, reused and look-alike destinations",
  ["ndst_L2", "ndst_L3", "ndst_L4", "ndst_L5", "ndst_L6", "ndst_L8", "ndst_D1", "ndst_D2", "ndst_S1", "ndst_S2", "ndst_S3", "ndst_S4"].every((id) => keptIds.includes(id)), keptIds);
const keptBefore = before.dests.filter((d) => keptIds.includes(d.id));
check("kept destinations are byte-identical (encrypted URLs untouched)", JSON.stringify(after.dests) === JSON.stringify(keptBefore));
check("alerts, monitors and website selections untouched (besides the race's own update)",
  after.alerts === before.alerts && JSON.stringify(after.sites) === JSON.stringify(before.sites) &&
  JSON.stringify(after.targets.map((t) => (t.id === "tgt_D2" ? { ...t, notificationDestinationId: null } : t))) === JSON.stringify(before.targets), { alerts: [before.alerts, after.alerts] });
const apply2 = cli(["--apply"]);
check("running again changes nothing and reports no errors", /Removed 0; kept 7\./.test(apply2) && JSON.stringify(await snapshot()) === JSON.stringify(after), apply2.trim().split("\n").at(-1));
const verify = execFileSync("npm", ["run", "-s", "secrets", "--", "verify"], { env: process.env, encoding: "utf8" });
check("all remaining encrypted values decrypt (secrets verify)", !/plaintext [1-9]|undecryptable [1-9]/.test(verify), verify);
const appRead = execFileSync(process.execPath, ["--import", "tsx", "e2e/read-dests.mts"], { env: process.env, encoding: "utf8" });
check("the app still reads kept destinations' real URLs", appRead.includes("https://ops.test/hook/tok-D1") && appRead.includes("https://h2.test/in/tok-L2"));

await c.end();
const failed = results.filter((r) => !r.ok);
console.log(`\n[G] ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
