/**
 * Optional snapshot pruning. Every check writes a snapshot row, changed or not, so
 * the table grows without bound. When SNAPSHOT_RETENTION_DAYS is set, the worker
 * deletes snapshots older than that many days — except the newest snapshot for
 * each monitor (keyed by website, kind, page URL, and monitor id), which is the diff
 * baseline for its next check and must survive no matter how old it is. Unset (the
 * default) keeps everything.
 *
 * Alerts do not reference snapshots (diffs are copied into alert.details), so
 * pruning never breaks an alert. It does shorten the per-monitor fetch history
 * and price history shown in the dashboard to the retention window.
 */

import { sql } from "drizzle-orm";
import { db } from "./db";

const DELETE_BATCH_SIZE = 5_000;

/** Parse a retention period in whole days; blank, non-integer, or < 1 means "keep everything". */
export function parseSnapshotRetentionDays(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

export function snapshotRetentionDays(): number | null {
  return parseSnapshotRetentionDays(process.env.SNAPSHOT_RETENTION_DAYS);
}

/**
 * Delete snapshots created before `now - retentionDays` that have a newer snapshot
 * for the same (websiteId, kind, targetUrl, targetId). Deletes in batches so a large backlog
 * never runs as one long statement. Returns the number of rows removed.
 */
export async function pruneSnapshots(retentionDays: number, nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      DELETE FROM "snapshot" WHERE "id" IN (
        SELECT s."id" FROM "snapshot" s
        WHERE s."createdAt" < ${cutoff}
          AND EXISTS (
            SELECT 1 FROM "snapshot" n
            WHERE n."websiteId" = s."websiteId"
              AND n."kind" = s."kind"
              AND n."targetUrl" IS NOT DISTINCT FROM s."targetUrl"
              AND n."targetId" IS NOT DISTINCT FROM s."targetId"
              AND n."createdAt" > s."createdAt"
          )
        LIMIT ${DELETE_BATCH_SIZE}
      )
    `);
    const deleted = res.rowCount ?? 0;
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) return total;
  }
}
