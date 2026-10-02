// 0010 backfill: a database at main's schema (0000–0009) with terminal deliveries, then this branch's migrations.
import pg from "pg";
import { migrationsUpTo } from "./migrations-upto.mjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { execFileSync } from "node:child_process";
const S = process.env.E2E_DIR!;
const url = process.env.DATABASE_URL!;
const c = new pg.Client({ connectionString: url });
await c.connect();
await migrate(drizzle(c), { migrationsFolder: migrationsUpTo(9, `${S}/migrations-upto-9`) });
const ins = (id: string, status: string, delivered: string | null, lastAttempt: string | null) =>
  c.query(`INSERT INTO "webhookDelivery" (id,"eventId","eventType",url,payload,status,"createdAt","deliveredAt","lastAttemptAt")
           VALUES ($1,$1,'watch.triggered','enc:v1:x:y:z','{}',$2, now() - interval '90 days', ${delivered ?? "NULL"}, ${lastAttempt ?? "NULL"})`, [id, status]);
await ins("bf_delivered", "delivered", "now() - interval '40 days'", "now() - interval '41 days'");
await ins("bf_delivered_noat", "delivered", null, "now() - interval '45 days'");
await ins("bf_failed", "failed", null, "now() - interval '35 days'");
await ins("bf_failed_noat", "failed", null, null);
await ins("bf_canceled", "canceled", null, "now() - interval '60 days'");
await ins("bf_pending", "pending", null, "now() - interval '50 days'");
const out = execFileSync("npm", ["run", "-s", "db:migrate:deploy"], { env: process.env, encoding: "utf8" });
const rows = Object.fromEntries((await c.query(`SELECT id, round(extract(epoch from (now() - "completedAt")) / 86400) AS age_days, "completedAt" IS NULL AS isnull FROM "webhookDelivery" WHERE id LIKE 'bf_%'`)).rows.map((r) => [r.id, r.isnull ? null : Number(r.age_days)]));
const expected = { bf_delivered: 40, bf_delivered_noat: 45, bf_failed: 35, bf_failed_noat: 0, bf_canceled: 0, bf_pending: null };
const ok = JSON.stringify(rows, Object.keys(expected).sort()) === JSON.stringify(expected, Object.keys(expected).sort());
const again = execFileSync("npm", ["run", "-s", "db:migrate:deploy"], { env: process.env, encoding: "utf8" });
console.log(JSON.stringify({ ok, rows, applied: /applied \d+ migration/.test(out), rerunUpToDate: /up to date \(\d+ applied\)/.test(again) }));
await c.end();
process.exit(ok && /up to date \(\d+ applied\)/.test(again) ? 0 : 1);
