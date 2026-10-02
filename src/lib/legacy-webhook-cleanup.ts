/**
 * Cleanup of WEBHOOK notification destinations left behind by the first Watcher API.
 *
 * Before signed webhooks (Phase 3), `POST /api/v1/watches` with a `callbackUrl` routed
 * alerts through a WEBHOOK destination: it reused one with the same URL, or created one
 * named exactly `API webhook (<host of the URL>)` with only the URL set (`createdAt` and
 * `updatedAt` equal). Migration 0006 moved each callback URL onto its watch and detached
 * the destination, but kept the rows. Those orphans receive nothing and only clutter
 * Settings.
 *
 * A destination is removed only when every one of these holds (anything else is kept):
 *  - channel WEBHOOK, name exactly `API webhook (<host>)` where <host> is the host of its
 *    own (decrypted) URL, and no Slack/email fields;
 *  - never edited since creation (`updatedAt = createdAt`; any dashboard edit bumps it);
 *  - its account had an API key when it was created (it came from the API);
 *  - no monitor uses it (`target.notificationDestinationId`, dashboard or API), and no
 *    website lists it in `notificationDestinationIds`.
 * Destinations the old API reused (a user's own, differently named) never match.
 *
 * Each removal is one transaction that locks the row and re-checks everything first, so
 * the cleanup is safe to interrupt and re-run, and a destination that becomes referenced
 * meanwhile is kept. Run via `npm run legacy-webhooks` (dry run) / `-- --apply`.
 */

import { and, count, eq, lte, sql } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Conn = typeof db | Tx;

export const LEGACY_NAME = /^API webhook \((.+)\)$/;

export type DestinationFacts = {
  channel: string;
  name: string;
  alertWebhookUrl: string | null;
  slackWebhookUrl: string | null;
  resendFromEmail: string | null;
  resendToEmails: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ReferenceFacts = { monitors: number; websites: number; ownerHadApiKey: boolean };

export type Verdict = { remove: boolean; reason: string };

/** Whether a destination even looks like a legacy API one (only these are reported). */
export function looksLegacy(d: Pick<DestinationFacts, "channel" | "name">): boolean {
  return d.channel === "WEBHOOK" && LEGACY_NAME.test(d.name);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Decide one legacy-looking destination. Pure; every "keep" says why. */
export function classifyLegacyDestination(d: DestinationFacts, refs: ReferenceFacts): Verdict {
  if (!looksLegacy(d)) return { remove: false, reason: "not a legacy API webhook destination" };
  if (d.slackWebhookUrl || d.resendFromEmail || d.resendToEmails) return { remove: false, reason: "has Slack or email settings" };
  if (!d.alertWebhookUrl) return { remove: false, reason: "has no webhook URL" };
  const host = hostOf(d.alertWebhookUrl);
  if (!host || d.name !== `API webhook (${host})`) return { remove: false, reason: "name does not match its URL's host" };
  if (d.updatedAt.getTime() !== d.createdAt.getTime()) return { remove: false, reason: "edited after it was created" };
  if (!refs.ownerHadApiKey) return { remove: false, reason: "its account had no API key when it was created" };
  if (refs.monitors > 0) return { remove: false, reason: `used by ${refs.monitors} monitor(s)` };
  if (refs.websites > 0) return { remove: false, reason: `selected on ${refs.websites} website(s)` };
  return { remove: true, reason: "unused destination created by the pre-signed-webhooks API" };
}

async function referenceFacts(conn: Conn, d: { id: string; userId: string; createdAt: Date }): Promise<ReferenceFacts> {
  const [monitors] = await conn.select({ n: count() }).from(schema.target).where(eq(schema.target.notificationDestinationId, d.id));
  // Substring match on the stored JSON list: an id appearing anywhere (even in a malformed
  // list) counts as a reference, which can only keep more.
  const [websites] = await conn
    .select({ n: count() })
    .from(schema.website)
    .where(sql`position(${d.id} in coalesce(${schema.website.notificationDestinationIds}, '')) > 0`);
  const [keys] = await conn
    .select({ n: count() })
    .from(schema.apiClient)
    .where(and(eq(schema.apiClient.ownerUserId, d.userId), lte(schema.apiClient.createdAt, d.createdAt)));
  return { monitors: monitors?.n ?? 0, websites: websites?.n ?? 0, ownerHadApiKey: (keys?.n ?? 0) > 0 };
}

export type CleanupItem = { id: string; name: string; createdAt: Date; verdict: Verdict; removed: boolean };

/**
 * Report every legacy-looking WEBHOOK destination and what happens to it. With `apply`,
 * remove the ones that qualify, each in its own transaction after re-checking under a row lock.
 */
export async function cleanupLegacyWebhookDestinations(options: { apply: boolean }): Promise<CleanupItem[]> {
  const rows = await db
    .select()
    .from(schema.notificationDestination)
    .where(and(eq(schema.notificationDestination.channel, "WEBHOOK"), sql`${schema.notificationDestination.name} LIKE 'API webhook (%)'`))
    .orderBy(schema.notificationDestination.createdAt, schema.notificationDestination.id);

  const items: CleanupItem[] = [];
  for (const row of rows) {
    if (!looksLegacy(row)) continue;
    let verdict = classifyLegacyDestination(row, await referenceFacts(db, row));
    let removed = false;
    if (verdict.remove && options.apply) {
      const outcome = await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(schema.notificationDestination)
          .where(eq(schema.notificationDestination.id, row.id))
          .for("update");
        if (!fresh) return { verdict: { remove: false, reason: "already gone" }, removed: false };
        const v = classifyLegacyDestination(fresh, await referenceFacts(tx, fresh));
        if (!v.remove) return { verdict: v, removed: false };
        await tx.delete(schema.notificationDestination).where(eq(schema.notificationDestination.id, row.id));
        return { verdict: v, removed: true };
      });
      verdict = outcome.verdict;
      removed = outcome.removed;
    }
    items.push({ id: row.id, name: row.name, createdAt: row.createdAt, verdict, removed });
  }
  return items;
}
