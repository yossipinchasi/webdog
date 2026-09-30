/**
 * Data access for the `/api/v1` Watcher API. A watch is a `target` row; every query
 * is scoped to the API client's owner account (`website.userId`).
 */

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import * as schema from "../db/schema";
import type { TargetKind } from "../db/schema";
import { newId } from "../ids";
import { parseProductSnapshotPayload } from "../product-price-history";
import { createWebsiteWithBrand } from "../website-create";
import { toWatchJson, type WatchJson } from "./watch-format";

const watchColumns = {
  target: schema.target,
  website: { id: schema.website.id, url: schema.website.url },
  destinationChannel: schema.notificationDestination.channel,
  destinationWebhookUrl: schema.notificationDestination.alertWebhookUrl,
};

type WatchRow = {
  target: typeof schema.target.$inferSelect;
  website: { id: string; url: string };
  destinationChannel: string | null;
  destinationWebhookUrl: string | null;
};

/** The webhook a watch reports to — only when it routes externally to a WEBHOOK destination. */
function callbackUrlOf(row: WatchRow): string | null {
  if (!row.target.externalNotify || row.destinationChannel !== "WEBHOOK") return null;
  return row.destinationWebhookUrl;
}

export function rowToWatchJson(row: WatchRow): WatchJson {
  return toWatchJson(row.target, row.website, callbackUrlOf(row));
}

/** Watches owned by `ownerId` matching `where`, newest first. */
export async function selectWatches(ownerId: string, where: SQL | undefined, limit: number): Promise<WatchRow[]> {
  return db
    .select(watchColumns)
    .from(schema.target)
    .innerJoin(schema.website, eq(schema.website.id, schema.target.websiteId))
    .leftJoin(
      schema.notificationDestination,
      eq(schema.notificationDestination.id, schema.target.notificationDestinationId),
    )
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

/** Reuse the account's WEBHOOK destination for `url`, or create one. Returns its id. */
export async function findOrCreateWebhookDestination(ownerId: string, url: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.notificationDestination.id })
    .from(schema.notificationDestination)
    .where(
      and(
        eq(schema.notificationDestination.userId, ownerId),
        eq(schema.notificationDestination.channel, "WEBHOOK"),
        eq(schema.notificationDestination.alertWebhookUrl, url),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = newId("ndst");
  const now = new Date();
  await db.insert(schema.notificationDestination).values({
    id,
    userId: ownerId,
    channel: "WEBHOOK",
    name: `API webhook (${new URL(url).host})`,
    slackWebhookUrl: null,
    resendFromEmail: null,
    resendToEmails: null,
    alertWebhookUrl: url,
    createdAt: now,
    updatedAt: now,
  });
  return id;
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

  const [snap] = await db
    .select({ payload: schema.snapshot.payload })
    .from(schema.snapshot)
    .where(eq(schema.snapshot.targetId, targetId))
    .orderBy(desc(schema.snapshot.createdAt))
    .limit(1);
  const product = snap ? parseProductSnapshotPayload(snap.payload) : null;
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
