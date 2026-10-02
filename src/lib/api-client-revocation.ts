/**
 * Revoked API clients: their watches stop.
 *
 * A watch belongs to a revoked client when `target.apiClientId` points at an `apiClient`
 * with `revokedAt` set. That is the only source of truth: watches keep their `enabled`
 * flag, so nothing can drift and re-enabling a watch cannot bypass revocation. Watches
 * and their history (events, snapshots, deliveries) are kept.
 *
 *  - Checks: every selection of targets to check excludes revoked clients' watches
 *    (`targetClientNotRevoked`), so the worker, "Run now" and manual checks skip them.
 *  - Events: transactions that record events or queue webhooks first take a shared lock
 *    on the client row and re-check `revokedAt` (`lockRevokedClientIds`). Revocation takes
 *    the row lock exclusively, so the two are ordered: either revocation committed first
 *    and nothing is recorded, or the event committed first and revocation cancels it.
 *  - Deliveries: revocation cancels the client's pending deliveries in the same
 *    transaction (`canceled` is terminal). Claiming skips revoked clients, and a canceled
 *    row is never moved back to pending. An HTTP attempt already in flight when
 *    revocation commits cannot be recalled; if it succeeds it is recorded as delivered.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const REVOKED_DELIVERY_ERROR = "Canceled: the API client was revoked.";

/**
 * SQL condition for queries over `target`: dashboard watches (no API client) and watches
 * of clients that are not revoked. Raw identifiers on purpose, so the correlated
 * subquery always refers to the outer `target` row.
 */
export const targetClientNotRevoked = sql`("target"."apiClientId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "apiClient" ac WHERE ac."id" = "target"."apiClientId" AND ac."revokedAt" IS NOT NULL))`;

/** Same, for queries over `webhookDelivery`. */
export const deliveryClientNotRevoked = sql`("webhookDelivery"."apiClientId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "apiClient" ac WHERE ac."id" = "webhookDelivery"."apiClientId" AND ac."revokedAt" IS NOT NULL))`;

/**
 * Inside a transaction that records events or queues webhooks: share-lock the given
 * clients' rows (blocking a concurrent revocation until this transaction ends) and
 * return the ones already revoked.
 */
export async function lockRevokedClientIds(tx: Tx, clientIds: Iterable<string | null | undefined>): Promise<Set<string>> {
  const ids = [...new Set([...clientIds].filter((id): id is string => Boolean(id)))].sort();
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: schema.apiClient.id, revokedAt: schema.apiClient.revokedAt })
    .from(schema.apiClient)
    .where(inArray(schema.apiClient.id, ids))
    .orderBy(schema.apiClient.id)
    .for("share");
  return new Set(rows.filter((r) => r.revokedAt !== null).map((r) => r.id));
}

/** Whether this client is revoked (no lock; for request validation and display). */
export async function isApiClientRevoked(apiClientId: string | null | undefined): Promise<boolean> {
  if (!apiClientId) return false;
  const [row] = await db
    .select({ revokedAt: schema.apiClient.revokedAt })
    .from(schema.apiClient)
    .where(eq(schema.apiClient.id, apiClientId))
    .limit(1);
  return Boolean(row?.revokedAt);
}

export type RevokeResult =
  | { found: false }
  | { found: true; revokedAt: Date; alreadyRevoked: boolean; canceledDeliveries: number };

/**
 * Revoke an API client: its key stops authenticating, its watches stop, and its pending
 * webhook deliveries are canceled, all in one transaction. Idempotent: revoking again
 * keeps the original `revokedAt` (and cancels anything still pending).
 */
export async function revokeApiClient(apiClientId: string, now = new Date()): Promise<RevokeResult> {
  return db.transaction(async (tx) => {
    const [client] = await tx
      .select({ id: schema.apiClient.id, revokedAt: schema.apiClient.revokedAt })
      .from(schema.apiClient)
      .where(eq(schema.apiClient.id, apiClientId))
      .for("update");
    if (!client) return { found: false } as const;

    const revokedAt = client.revokedAt ?? now;
    if (!client.revokedAt) {
      await tx
        .update(schema.apiClient)
        .set({ revokedAt })
        .where(and(eq(schema.apiClient.id, apiClientId), isNull(schema.apiClient.revokedAt)));
    }
    const canceled = await tx
      .update(schema.webhookDelivery)
      .set({ status: "canceled", lastError: REVOKED_DELIVERY_ERROR })
      .where(and(eq(schema.webhookDelivery.apiClientId, apiClientId), eq(schema.webhookDelivery.status, "pending")))
      .returning({ id: schema.webhookDelivery.id });
    return { found: true, revokedAt, alreadyRevoked: Boolean(client.revokedAt), canceledDeliveries: canceled.length } as const;
  });
}
