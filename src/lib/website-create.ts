/**
 * Create a website row for an account, enriched with Context.dev brand data (logo,
 * title, description) and a hero screenshot when a Context.dev key is available.
 * Shared by the dashboard's `POST /api/websites` and the `/api/v1` Watcher API.
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";
import { newId } from "./ids";
import { ContextDevError, pickBrandAssets, retrieveBrand, scrapeScreenshot } from "./context-client";
import { effectiveContextDevApiKey } from "./server-managed-config";

/** Insert a website for `domain` (already normalized) owned by `ownerId`; returns its id. */
export async function createWebsiteWithBrand(ownerId: string, domain: string): Promise<string> {
  const [settings] = await db
    .select({ contextDevApiKey: schema.userNotificationSettings.contextDevApiKey })
    .from(schema.userNotificationSettings)
    .where(eq(schema.userNotificationSettings.userId, ownerId))
    .limit(1);
  const contextKey = effectiveContextDevApiKey(settings?.contextDevApiKey);
  const hasContextKey = Boolean(contextKey);

  let assets = pickBrandAssets(null);
  let heroScreenshotUrl: string | null = null;

  await Promise.all([
    (async () => {
      if (!hasContextKey) return;
      try {
        const brand = await retrieveBrand(domain, { apiKey: contextKey });
        assets = pickBrandAssets(brand);
      } catch (err) {
        if (err instanceof ContextDevError && err.status !== 404) {
          console.warn(`retrieveBrand(${domain}) failed:`, err.message);
        }
      }
    })(),
    (async () => {
      if (!hasContextKey) return;
      try {
        const shot = await scrapeScreenshot({ domain, apiKey: contextKey, prioritize: "quality" });
        if (shot.screenshot) heroScreenshotUrl = shot.screenshot;
      } catch (err) {
        if (err instanceof ContextDevError) {
          console.warn(`scrapeScreenshot(${domain}) failed:`, err.message);
        } else {
          throw err;
        }
      }
    })(),
  ]);

  const id = newId("web");
  await db.insert(schema.website).values({
    id,
    userId: ownerId,
    name: assets.title ?? domain,
    url: `https://${domain}`,
    domain,
    title: assets.title,
    description: assets.description,
    logoUrl: assets.logoUrl,
    heroScreenshotUrl,
    backdropUrl: assets.backdropUrl,
    createdAt: new Date(),
  });
  return id;
}
