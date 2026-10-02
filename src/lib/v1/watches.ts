/**
 * Data access for the `/api/v1` Watcher API. A watch is a `target` row; every query
 * is scoped to the API client's owner account (`website.userId`).
 */

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import * as schema from "../db/schema";
import type { TargetKind } from "../db/schema";
import { parseProductSnapshotPayload } from "../product-price-history";
import { createWebsiteWithBrand } from "../website-create";
import { resolveAiSummaryConfig, type AiSummaryConfig } from "../ai-change-summary";
import { toWatchJson, type WatchJson } from "./watch-format";

const watchColumns = {
  target: schema.target,
  website: { id: schema.website.id, url: schema.website.url },
  clientRevokedAt: schema.apiClient.revokedAt,
};

type WatchRow = {
  target: typeof schema.target.$inferSelect;
  website: { id: string; url: string };
  /** Set when the API client that created the watch was revoked: the watch no longer runs. */
  clientRevokedAt: Date | null;
};

export function rowToWatchJson(row: WatchRow): WatchJson {
  return toWatchJson(row.target, row.website, row.target.callbackUrl, row.clientRevokedAt !== null);
}

/** Watches owned by `ownerId` matching `where`, newest first. */
export async function selectWatches(ownerId: string, where: SQL | undefined, limit: number): Promise<WatchRow[]> {
  return db
    .select(watchColumns)
    .from(schema.target)
    .innerJoin(schema.website, eq(schema.website.id, schema.target.websiteId))
    .leftJoin(schema.apiClient, eq(schema.apiClient.id, schema.target.apiClientId))
    .where(and(eq(schema.website.userId, ownerId), where))
    .orderBy(desc(schema.target.createdAt), desc(schema.target.id))
    .limit(limit);
}

export async function loadWatch(ownerId: string, watchId: string): Promise<WatchRow | null> {
  const [row] = await selectWatches(ownerId, eq(schema.target.id, watchId), 1);
  return row ?? null;
}

export async function findWatchByExternalRef(
  ownerId: string,
  apiClientId: string,
  externalRef: string,
): Promise<WatchRow | null> {
  const [row] = await selectWatches(
    ownerId,
    and(eq(schema.target.apiClientId, apiClientId), eq(schema.target.externalRef, externalRef)),
    1,
  );
  return row ?? null;
}

/** Reuse the account's website for `domain`, or create one (with brand data). */
export async function findOrCreateWebsite(ownerId: string, domain: string): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select({ id: schema.website.id })
    .from(schema.website)
    .where(and(eq(schema.website.userId, ownerId), eq(schema.website.domain, domain)))
    .orderBy(schema.website.createdAt)
    .limit(1);
  if (existing) return { id: existing.id, created: false };
  return { id: await createWebsiteWithBrand(ownerId, domain), created: true };
}

/**
 * After a creation-time baseline check: why the watch should be rejected, or null when
 * the baseline is usable (the check succeeded and, for price watches, found a product).
 */
export async function baselineFailure(
  targetId: string,
  kind: TargetKind,
): Promise<{ code: string; message: string } | null> {
  const [t] = await db
    .select({ lastError: schema.target.lastError })
    .from(schema.target)
    .where(eq(schema.target.id, targetId))
    .limit(1);
  if (t?.lastError) return { code: "baseline_failed", message: t.lastError };
  if (kind !== "PRODUCT_PRICE") return null;

  const payload = await latestSnapshotPayload(targetId);
  const product = payload ? parseProductSnapshotPayload(payload) : null;
  if (!product?.is_product_page) {
    return { code: "not_a_product_page", message: "No product was found on that page, so there is no price to watch." };
  }
  return null;
}

/** Remove a watch rejected at creation, plus its website when this request created it and it is now empty. */
export async function discardWatch(targetId: string, website: { id: string; created: boolean }): Promise<void> {
  await db.delete(schema.snapshot).where(eq(schema.snapshot.targetId, targetId));
  await db.delete(schema.target).where(eq(schema.target.id, targetId));
  if (!website.created) return;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.target)
    .where(eq(schema.target.websiteId, website.id));
  if (n === 0) await db.delete(schema.website).where(eq(schema.website.id, website.id));
}

/** The account's effective AI config (server-managed keys or its own), or null. */
export async function accountAiConfig(ownerId: string): Promise<AiSummaryConfig | null> {
  const [row] = await db
    .select({
      aiProvider: schema.userNotificationSettings.aiProvider,
      openaiApiKey: schema.userNotificationSettings.openaiApiKey,
      vercelAiGatewayApiKey: schema.userNotificationSettings.vercelAiGatewayApiKey,
      aiModel: schema.userNotificationSettings.aiModel,
    })
    .from(schema.userNotificationSettings)
    .where(eq(schema.userNotificationSettings.userId, ownerId))
    .limit(1);
  return resolveAiSummaryConfig(row);
}

/** The payload of a watch's most recent snapshot, or null before its first check. */
export async function latestSnapshotPayload(targetId: string): Promise<string | null> {
  const [snap] = await db
    .select({ payload: schema.snapshot.payload })
    .from(schema.snapshot)
    .where(eq(schema.snapshot.targetId, targetId))
    .orderBy(desc(schema.snapshot.createdAt))
    .limit(1);
  return snap?.payload ?? null;
}
