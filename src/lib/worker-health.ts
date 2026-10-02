/**
 * Worker health, stored in Postgres so the web service can report on a separate worker.
 *
 * A heartbeat means a loop **completed a pass**, not that the process is alive: a loop
 * that hangs or keeps failing stops producing heartbeats even while the process runs.
 * There is one row per loop (`checks`, `webhooks`), so the state never grows.
 *
 * After each successful pass the worker writes `dueBy`, the time by which the next pass
 * should have succeeded: the database's `now()` + the time until the loop's next run
 * + a grace period (at least `CHECKS_GRACE_SECONDS` / `WEBHOOKS_GRACE_SECONDS`, or twice
 * the pass's duration if longer). The worker knows its own schedule (SCRAPE_CRON,
 * WEBHOOK_POLL_SECONDS); the web service doesn't need to. A loop is stale when the
 * database clock passes `dueBy`. All times are database time.
 *
 * Several workers update the same rows; timestamps only move forward (GREATEST), so an
 * older or slower write never makes the state look older than it is. The loop is
 * healthy when any worker keeps it progressing.
 */

import { sql } from "drizzle-orm";
import { db } from "./db";

export type WorkerLoop = "checks" | "webhooks";
export const WORKER_LOOPS: readonly WorkerLoop[] = ["checks", "webhooks"];

/** Allowance for a checks pass (scraping every due site) beyond the next scheduled run. */
export const CHECKS_GRACE_SECONDS = 15 * 60;
/** Allowance for a delivery pass beyond the next poll. */
export const WEBHOOKS_GRACE_SECONDS = 2 * 60;

/** Seconds after now by which the next pass should have succeeded. */
export function dueInSeconds(loop: WorkerLoop, untilNextRunMs: number, passDurationMs: number): number {
  const grace = loop === "checks" ? CHECKS_GRACE_SECONDS : WEBHOOKS_GRACE_SECONDS;
  return Math.ceil(Math.max(0, untilNextRunMs) / 1000 + Math.max(grace, (2 * passDurationMs) / 1000));
}

export async function recordPassStart(loop: WorkerLoop): Promise<void> {
  await db.execute(sql`
    INSERT INTO "workerHeartbeat" ("loop", "lastStartedAt", "updatedAt") VALUES (${loop}, now(), now())
    ON CONFLICT ("loop") DO UPDATE SET
      "lastStartedAt" = GREATEST("workerHeartbeat"."lastStartedAt", EXCLUDED."lastStartedAt"),
      "updatedAt" = now()`);
}

export async function recordPassSuccess(loop: WorkerLoop, dueIn: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO "workerHeartbeat" ("loop", "lastSuccessAt", "dueBy", "updatedAt")
    VALUES (${loop}, now(), now() + make_interval(secs => ${dueIn}), now())
    ON CONFLICT ("loop") DO UPDATE SET
      "lastSuccessAt" = GREATEST("workerHeartbeat"."lastSuccessAt", EXCLUDED."lastSuccessAt"),
      "dueBy" = GREATEST("workerHeartbeat"."dueBy", EXCLUDED."dueBy"),
      "updatedAt" = now()`);
}

/** A pass failed as a whole. No error text is stored (it could name internal hosts). */
export async function recordPassFailure(loop: WorkerLoop): Promise<void> {
  await db.execute(sql`
    INSERT INTO "workerHeartbeat" ("loop", "lastFailureAt", "updatedAt") VALUES (${loop}, now(), now())
    ON CONFLICT ("loop") DO UPDATE SET
      "lastFailureAt" = GREATEST("workerHeartbeat"."lastFailureAt", EXCLUDED."lastFailureAt"),
      "updatedAt" = now()`);
}

/** Heartbeat writes must never break the loop they report on. */
export async function safely(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error("[worker] could not record heartbeat:", err instanceof Error ? err.message : err);
  }
}

export type LoopStatus = "healthy" | "stale" | "never_run";

export type LoopHealth = {
  status: LoopStatus;
  /** Last completed pass. */
  lastSuccessAt: string | null;
  secondsSinceSuccess: number | null;
  /** The loop counts as stale after this time unless another pass completes. */
  staleAfter: string | null;
  /** The most recent pass failed (a later success clears it). */
  lastPassFailed: boolean;
  /** A pass started and has not finished yet (checks loop only). */
  runningSince: string | null;
};

export type WorkerHealth = {
  status: "healthy" | "unhealthy" | "never_run";
  /** Database time the report was computed at. */
  checkedAt: string;
  loops: Record<WorkerLoop, LoopHealth>;
};

type Row = {
  lastStartedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  dueBy: Date | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const t = (d: Date | null) => (d ? d.getTime() : -Infinity);

/** Pure: one loop's health from its row and the database's now. */
export function loopHealth(row: Row | undefined, now: Date): LoopHealth {
  if (!row || !row.lastSuccessAt) {
    return {
      status: "never_run",
      lastSuccessAt: null,
      secondsSinceSuccess: null,
      staleAfter: null,
      lastPassFailed: Boolean(row?.lastFailureAt),
      runningSince: row?.lastStartedAt && t(row.lastStartedAt) > t(row.lastFailureAt) ? iso(row.lastStartedAt) : null,
    };
  }
  const healthy = row.dueBy !== null && now.getTime() <= row.dueBy.getTime();
  return {
    status: healthy ? "healthy" : "stale",
    lastSuccessAt: iso(row.lastSuccessAt),
    secondsSinceSuccess: Math.max(0, Math.round((now.getTime() - row.lastSuccessAt.getTime()) / 1000)),
    staleAfter: iso(row.dueBy),
    lastPassFailed: t(row.lastFailureAt) > t(row.lastSuccessAt),
    runningSince:
      row.lastStartedAt && t(row.lastStartedAt) > Math.max(t(row.lastSuccessAt), t(row.lastFailureAt)) ? iso(row.lastStartedAt) : null,
  };
}

/** Pure: overall status. Healthy only when every loop is. */
export function overallStatus(loops: Record<WorkerLoop, LoopHealth>): WorkerHealth["status"] {
  const statuses = WORKER_LOOPS.map((l) => loops[l].status);
  if (statuses.every((s) => s === "healthy")) return "healthy";
  if (statuses.every((s) => s === "never_run")) return "never_run";
  return "unhealthy";
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  const res = await db.execute<Row & { loop: string; now: Date }>(sql`
    SELECT n.now, h."loop", h."lastStartedAt", h."lastSuccessAt", h."lastFailureAt", h."dueBy"
    FROM (SELECT now() AS now) n LEFT JOIN "workerHeartbeat" h ON true`);
  const now = new Date(res.rows[0]!.now);
  const byLoop = new Map(res.rows.filter((r) => r.loop).map((r) => [r.loop, r]));
  const loops = Object.fromEntries(
    WORKER_LOOPS.map((l) => {
      const r = byLoop.get(l);
      const row = r
        ? {
            lastStartedAt: r.lastStartedAt ? new Date(r.lastStartedAt) : null,
            lastSuccessAt: r.lastSuccessAt ? new Date(r.lastSuccessAt) : null,
            lastFailureAt: r.lastFailureAt ? new Date(r.lastFailureAt) : null,
            dueBy: r.dueBy ? new Date(r.dueBy) : null,
          }
        : undefined;
      return [l, loopHealth(row, now)];
    }),
  ) as Record<WorkerLoop, LoopHealth>;
  return { status: overallStatus(loops), checkedAt: now.toISOString(), loops };
}
