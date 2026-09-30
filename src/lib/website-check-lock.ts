/**
 * Cross-process mutual exclusion for a website's scrape + diff run.
 *
 * `runWebsiteChecks` reads the latest snapshot, scrapes, then writes the new
 * snapshot and alerts. Two overlapping runs for the same website (a slow worker
 * tick overlapping the next, a second worker process, or "Check now" during a
 * scheduled run) would both diff against the same baseline and emit duplicate
 * alerts. A Postgres session-level advisory lock keyed on the website id makes
 * those runs mutually exclusive across every process sharing the database; if a
 * holder crashes, its connection closes and Postgres releases the lock.
 *
 * Locks live on a dedicated small pool, separate from the Drizzle pool, so a burst
 * of lock holders can never exhaust the connections their own queries need.
 * Session advisory locks require a direct (or session-mode pooled) connection;
 * they do not work behind a transaction-mode pooler such as PgBouncer.
 */

import pg from "pg";
import { resolveDatabaseUrl } from "./db/database-url";

/** Advisory-lock namespace ("WDOG") so these keys can't collide with other lock users. */
const LOCK_NAMESPACE = 0x57444f47;

declare global {
  var webdogLockPool: pg.Pool | undefined;
}

function lockPool(): pg.Pool {
  if (!globalThis.webdogLockPool) {
    globalThis.webdogLockPool = new pg.Pool({
      connectionString: resolveDatabaseUrl(),
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalThis.webdogLockPool;
}

export type LockedRun<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Run `fn` while holding the website's check lock. Never waits: when another run
 * already holds the lock, returns `{ acquired: false }` without calling `fn`.
 */
export async function withWebsiteCheckLock<T>(websiteId: string, fn: () => Promise<T>): Promise<LockedRun<T>> {
  const client = await lockPool().connect();
  let acquired = false;
  let releaseError: Error | undefined;
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
      [LOCK_NAMESPACE, websiteId],
    );
    acquired = res.rows[0]?.locked === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await fn() };
  } finally {
    if (acquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [LOCK_NAMESPACE, websiteId]);
      } catch (err) {
        // Destroy the connection instead of returning it to the pool: closing the
        // session is what guarantees Postgres drops a lock we failed to release.
        releaseError = err instanceof Error ? err : new Error(String(err));
        console.error(`failed to release check lock for website ${websiteId}:`, err);
      }
    }
    client.release(releaseError);
  }
}
