#!/usr/bin/env tsx
// Production migration command (`npm run db:migrate:deploy`). Both Railway services run
// it as their pre-deploy step, so it must be safe to run concurrently: it holds a
// Postgres advisory lock while Drizzle applies pending migrations from `drizzle/`.
// The first caller migrates; the others wait for the lock and then find nothing to do,
// which also guarantees neither service starts new code against an old schema.
//
// Drizzle picks the pending migrations before opening its transaction, so two
// unlocked runs could both apply them; the lock is what prevents that. Pending
// migrations are applied in one transaction: a failure leaves the database unchanged.
// Uses the same `drizzle.__drizzle_migrations` table as `drizzle-kit migrate`.
//
// Still under the lock, it then encrypts any credentials stored as plaintext before
// encryption at rest (see src/lib/secret-backfill.ts; safe to interrupt and re-run).
// Env: DATABASE_URL, DATA_ENCRYPTION_KEY (required in production).

import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolveDatabaseUrl } from "../src/lib/db/database-url";
import { backfillSecrets } from "../src/lib/secret-backfill";

/** Advisory-lock key ("WDOG", "MIGR"); distinct from the per-website check locks. */
const LOCK_KEY = [0x57444f47, 0x4d494752] as const;
/** Give up (and fail the deploy) rather than wait forever behind a stuck migration. */
const LOCK_TIMEOUT = "10min";

async function main() {
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    const started = Date.now();
    await client.query("SELECT pg_advisory_lock($1, $2)", [...LOCK_KEY]);
    const waited = Date.now() - started;
    console.log(`[migrate] lock acquired${waited > 1000 ? ` after ${Math.round(waited / 1000)}s` : ""}`);

    const before = await appliedCount(client);
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    const after = await appliedCount(client);
    console.log(
      after > before ? `[migrate] applied ${after - before} migration(s); ${after} total` : `[migrate] up to date (${after} applied)`,
    );

    const encrypted = (await backfillSecrets(client)).filter((r) => r.encrypted > 0);
    console.log(
      encrypted.length
        ? `[migrate] encrypted plaintext secrets: ${encrypted.map((r) => `${r.column}=${r.encrypted}`).join(", ")}`
        : "[migrate] no plaintext secrets to encrypt",
    );
  } finally {
    // Closing the session releases the lock even if unlocking fails.
    await client.query("SELECT pg_advisory_unlock($1, $2)", [...LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

async function appliedCount(client: pg.Client): Promise<number> {
  // Two queries: Postgres resolves every table in a statement up front, so a single
  // CASE over a not-yet-created table fails on a fresh database.
  const exists = await client.query<{ t: string | null }>("SELECT to_regclass('drizzle.__drizzle_migrations') AS t");
  if (!exists.rows[0]?.t) return 0;
  const res = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
  return res.rows[0]?.n ?? 0;
}

main().catch((err: unknown) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
