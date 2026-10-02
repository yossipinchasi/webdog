/**
 * Webhook delivery retention. Every watch event leaves a `webhookDelivery` row, so the
 * worker deletes terminal deliveries (delivered, failed, canceled) whose `completedAt`
 * is older than WEBHOOK_DELIVERY_RETENTION_DAYS (default 30).
 *
 *  - Only terminal rows are eligible. A `pending` row (new, retrying, or claimed and in
 *    flight) has `completedAt` null and is never deleted, however old it is.
 *  - Age is measured from completion, not creation, by the database clock: a delivery
 *    created long ago that failed yesterday is kept for the full period.
 *  - Strictly older than the cutoff: a row exactly `days` old is kept until the next run.
 *  - Deletes run in batches of their own short transactions, oldest first, with
 *    `FOR UPDATE SKIP LOCKED`: concurrent pruners take disjoint rows, and a row another
 *    transaction holds (e.g. a retry moving it back to pending) is skipped and its status
 *    re-checked, so nothing that just became pending is deleted. An interrupted run leaves
 *    only whole batches deleted; the next run continues.
 *
 * Deleted deliveries disappear from `GET /watches/:id/deliveries` and can no longer be
 * retried. Events (alerts) are separate rows and are not affected.
 */

import { sql } from "drizzle-orm";
import { db } from "./db";

export const DEFAULT_DELIVERY_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1_000;
/** Per run; a larger backlog continues on the next run instead of holding the worker. */
const DEFAULT_MAX_BATCHES = 200;

/**
 * Days to keep terminal deliveries: unset → 30; a positive integer → that; "off" → keep
 * everything (null). Anything else logs a warning and uses the default, so a typo neither
 * stops pruning nor deletes more than intended.
 */
export function parseDeliveryRetentionDays(raw: string | null | undefined): number | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return DEFAULT_DELIVERY_RETENTION_DAYS;
  if (s === "off") return null;
  const n = Number(s);
  if (Number.isSafeInteger(n) && n >= 1) return n;
  console.warn(
    `[retention] WEBHOOK_DELIVERY_RETENTION_DAYS must be a whole number of days ≥ 1 or "off"; using ${DEFAULT_DELIVERY_RETENTION_DAYS}.`,
  );
  return DEFAULT_DELIVERY_RETENTION_DAYS;
}

export function deliveryRetentionDays(): number | null {
  return parseDeliveryRetentionDays(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS);
}

export type DeliveryPruneResult = { deleted: number; batches: number; complete: boolean };

/** Delete terminal deliveries completed more than `retentionDays` ago, in bounded batches. */
export async function pruneWebhookDeliveries(
  retentionDays: number,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<DeliveryPruneResult> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error("retentionDays must be a whole number ≥ 1");
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const result: DeliveryPruneResult = { deleted: 0, batches: 0, complete: false };
  while (result.batches < maxBatches) {
    const res = await db.execute(sql`
      DELETE FROM "webhookDelivery" d USING (
        SELECT "id" FROM "webhookDelivery"
        WHERE "completedAt" IS NOT NULL
          AND "completedAt" < now() - make_interval(days => ${retentionDays})
          AND "status" IN ('delivered', 'failed', 'canceled')
        ORDER BY "completedAt"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ) old
      WHERE d."id" = old."id"`);
    const deleted = res.rowCount ?? 0;
    result.batches += 1;
    result.deleted += deleted;
    if (deleted < batchSize) {
      result.complete = true;
      break;
    }
  }
  return result;
}
