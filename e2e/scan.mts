// Full-database and log scan for plaintext credentials after the E2E run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const S = process.env.E2E_DIR!;
const s = JSON.parse(readFileSync(`${S}/secrets.json`, "utf8"));
const st = JSON.parse(readFileSync(`${S}/state.json`, "utf8"));
const tok = (u: string) => u.split("/").pop()!;
const needles = [s.contextDevApiKey, s.openaiApiKey, s.resendApiKey, s.webhookSecret, tok(s.slackWebhookUrl), tok(s.alertWebhookUrl), tok(s.callbackUrl), tok(s.queuedUrl), ...st.extraTokens, ...(st.extraSecrets ?? [])];
const PG_EXEC = process.env.E2E_PG_EXEC ?? "docker compose exec -T postgres";
const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
const dump = execFileSync("sh", ["-c", `${PG_EXEC} pg_dump -U postgres --data-only ${dbName}`], { encoding: "utf8", maxBuffer: 1 << 28 });
const logs = ["app.log", "app2.log", "app3.log", "worker-A.log", "worker-R.log", "worker-L.log", "worker-P.log"].map((f) => readFileSync(`${S}/${f}`, "utf8")).join("\n");
const inDb = needles.filter((n) => dump.includes(n));
const inLogs = needles.filter((n) => logs.includes(n));
console.log(JSON.stringify({ credentialsChecked: needles.length, dumpBytes: dump.length, plaintextInDatabase: inDb.length, plaintextInServerOrWorkerLogs: inLogs.length }));
process.exit(inDb.length || inLogs.length ? 1 : 0);
