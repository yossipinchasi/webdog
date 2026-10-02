/**
 * Per-website scrape + diff pipeline. The worker calls `runWebsiteChecks(websiteId)`
 * on a schedule; this module is also used by the manual-trigger API route.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";
import {
  ContextDevError,
  extractProduct,
  scrapeMarkdown,
  scrapeScreenshot,
  scrapeSitemap,
  parseDomain,
} from "./context-client";
import { newId } from "./ids";
import type { Alert, AlertKind, NotificationChannel, Target } from "./db/schema";
import { dispatchNewAlertsForDestinations } from "./dispatch-new-alerts";
import { resolveDestinationsForTarget } from "./website-notification-destinations";
import { authPublicBaseUrl } from "./auth";
import { alertDashboardDeepLink, buildNewAlertsPayload, type NewAlertsAlert } from "./notification-new-alerts";
import { diffPreview } from "./diff-preview";
import {
  mergeAlertDetails,
  resolveAiSummaryConfig,
  trySummarizeAlert,
  type AlertDetailsForSummary,
} from "./ai-change-summary";
import { triageAlert } from "./ai-alert-triage";
import { withWebsiteCheckLock } from "./website-check-lock";
import { lockRevokedClientIds, targetClientNotRevoked } from "./api-client-revocation";
import { parseStoredCondition, type ConditionOutcome } from "./watch-conditions";
import { evaluateChangeCondition } from "./watch-condition-eval";
import { deliverDueWebhooks, enqueueWebhook, watchErrorThreshold } from "./webhook-outbox";
import { buildErrorEvent, buildRecoveredEvent, buildTriggeredEvent } from "./watcher-events";
import { toWatchEventJson, toWebhookWatchJson } from "./v1/watch-format";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** A short, user-facing reason a check failed (stored on target.lastError). */
function describeCheckError(err: unknown): string {
  if (err instanceof ContextDevError) {
    if (err.status === 404) return "Page not found (404). Check the URL is correct and publicly reachable.";
    if (err.status === 403 || err.status === 401) return "The page blocked our request (auth/permission).";
    if (err.status === 429) return "Rate limited by context.dev. Will retry on the next check.";
    if (err.status >= 500) return "The page or scraper is temporarily unavailable. We'll retry.";
    return err.message || `Check failed (${err.status}).`;
  }
  if (err instanceof Error && err.message) return err.message;
  return "The check failed for an unknown reason.";
}

/**
 * A monitor's diff baseline: its own most recent snapshot. Keyed by monitor (not URL)
 * so several monitors on one page each see every change since *their* last check.
 */
async function latestSnapshot(targetId: string) {
  const rows = await db
    .select()
    .from(schema.snapshot)
    .where(eq(schema.snapshot.targetId, targetId))
    .orderBy(desc(schema.snapshot.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The snapshot row a successful check of `target` stores, from this run's scrape cache. */
function snapshotForTarget(
  target: Target,
  cache: SiteScrapeCache,
): Pick<typeof schema.snapshot.$inferInsert, "kind" | "targetUrl" | "payload" | "hash"> | null {
  if (target.kind === "SITEMAP_LINKS") {
    return cache.sitemap
      ? { kind: "SITEMAP", targetUrl: null, payload: JSON.stringify(cache.sitemap.urls), hash: cache.sitemap.hash }
      : null;
  }
  if (!target.pageUrl) return null;
  if (target.kind === "PRODUCT_PRICE") {
    const p = cache.product.get(target.pageUrl);
    return p ? { kind: "PRODUCT", targetUrl: target.pageUrl, payload: p.payload, hash: p.hash } : null;
  }
  const md = cache.markdown.get(target.pageUrl);
  return md ? { kind: "MARKDOWN", targetUrl: target.pageUrl, payload: md.md, hash: md.hash } : null;
}

export { diffPreview } from "./diff-preview";

interface ProductSnapshotData {
  is_product_page: boolean;
  platform: string | null;
  productName: string | null;
  price: number | null;
  currency: string | null;
}

function priceChangeKey(p: { price: number | null; currency: string | null }): string {
  const c = p.currency ?? "";
  if (p.price === null || p.price === undefined) return `${c}\t`;
  return `${c}\t${p.price}`;
}

interface SiteScrapeCache {
  sitemap?: { urls: string[]; hash: string };
  markdown: Map<string, { md: string; hash: string }>;
  product: Map<string, { payload: string; hash: string }>;
  /** Latest page screenshot URL per page URL (context.dev CDN). */
  screenshot: Map<string, string>;
  /** Per-user context.dev key; null = use env only. */
  contextApiKey: string | null;
}

/**
 * Best-effort screenshot of the watched page for the "current version" view.
 * Never throws — a screenshot failure must not fail the content/price check.
 */
async function ensurePageScreenshot(pageUrl: string, cache: SiteScrapeCache): Promise<string | null> {
  const cached = cache.screenshot.get(pageUrl);
  if (cached) return cached;
  try {
    const shot = await scrapeScreenshot({ directUrl: pageUrl, apiKey: cache.contextApiKey });
    const url = shot.screenshot?.trim() || null;
    if (url) cache.screenshot.set(pageUrl, url);
    return url;
  } catch (err) {
    const message = err instanceof ContextDevError ? err.message : String(err);
    console.warn(`screenshot failed for ${pageUrl}:`, message);
    return null;
  }
}

async function ensureSitemap(website: { id: string; url: string; domain: string }, cache: SiteScrapeCache) {
  if (cache.sitemap) return cache.sitemap;
  const result = await scrapeSitemap(website.domain, { apiKey: cache.contextApiKey });
  const urls = [...result.urls].sort();
  cache.sitemap = { urls, hash: sha256(urls.join("\n")) };
  return cache.sitemap;
}

async function ensureMarkdown(pageUrl: string, cache: SiteScrapeCache) {
  const cached = cache.markdown.get(pageUrl);
  if (cached) return cached;
  const result = await scrapeMarkdown(pageUrl, { useMainContentOnly: true, apiKey: cache.contextApiKey });
  const md = result.markdown ?? "";
  const value = { md, hash: sha256(md) };
  cache.markdown.set(pageUrl, value);
  return value;
}

interface AlertInsert {
  id: string;
  websiteId: string;
  targetId: string;
  kind: AlertKind;
  title: string;
  details: string;
  createdAt: Date;
  /** Extra context for LLM summary; not persisted to alert.details. */
  summaryDetails?: AlertDetailsForSummary;
  /** Set by the AI relevance filter: held as noise (stored, read, not notified). */
  suppressed?: boolean;
  /** Short rationale for suppression; null unless suppressed. */
  suppressionReason?: string | null;
  /** Outcome of the monitor's condition; unset when it has none. */
  condition?: ConditionOutcome;
}

function linkScopeEmits(scope: string | null | undefined, variant: "new" | "removed"): boolean {
  const s = scope ?? "BOTH";
  if (s === "BOTH") return true;
  if (variant === "new") return s === "NEW";
  return s === "REMOVED";
}

async function handleLinkTarget(
  website: { id: string; url: string; domain: string },
  target: Target,
  cache: SiteScrapeCache,
  alerts: AlertInsert[],
): Promise<void> {
  const current = await ensureSitemap(website, cache);
  const prev = await latestSnapshot(target.id);
  const prevUrls: string[] = prev ? (JSON.parse(prev.payload) as string[]) : [];

  const prevSet = new Set(prevUrls);
  const currSet = new Set(current.urls);
  const added = current.urls.filter((u) => !prevSet.has(u));
  const removed = prevUrls.filter((u) => !currSet.has(u));

  const now = new Date();
  const scope = target.linkScope;
  if (linkScopeEmits(scope, "new") && added.length > 0 && prev) {
    alerts.push({
      id: newId("alt"),
      websiteId: website.id,
      targetId: target.id,
      kind: "NEW_LINK",
      title: `${added.length} new link${added.length === 1 ? "" : "s"} on ${website.domain}`,
      details: JSON.stringify({ added: added.slice(0, 100) }),
      createdAt: now,
    });
  }
  if (linkScopeEmits(scope, "removed") && removed.length > 0 && prev) {
    alerts.push({
      id: newId("alt"),
      websiteId: website.id,
      targetId: target.id,
      kind: "REMOVED_LINK",
      title: `${removed.length} link${removed.length === 1 ? "" : "s"} removed from ${website.domain}`,
      details: JSON.stringify({ removed: removed.slice(0, 100) }),
      createdAt: now,
    });
  }
}

async function handleContentTarget(
  website: { id: string; url: string; domain: string },
  target: Target,
  cache: SiteScrapeCache,
  alerts: AlertInsert[],
): Promise<void> {
  if (!target.pageUrl) return;
  const page = target.pageUrl;
  const curr = await ensureMarkdown(page, cache);
  const prev = await latestSnapshot(target.id);
  // The screenshot only backs the "current version" thumbnail, not change
  // detection (that's the markdown hash). Capture it on the first snapshot and
  // whenever the content actually changes; an unchanged page keeps its last
  // screenshot, so we don't spend a context.dev capture on every quiet check.
  if (!prev || prev.hash !== curr.hash) {
    await ensurePageScreenshot(page, cache);
  }
  if (prev && prev.hash !== curr.hash) {
    const { preview, totalAdded, totalRemoved } = diffPreview(prev.payload, curr.md);
    alerts.push({
      id: newId("alt"),
      websiteId: website.id,
      targetId: target.id,
      kind: "PAGE_CONTENT",
      title: `Content changed on ${page}`,
      details: JSON.stringify({ pageUrl: page, diffPreview: preview, totalAdded, totalRemoved }),
      createdAt: new Date(),
      summaryDetails: {
        pageUrl: page,
        beforeMarkdown: prev.payload,
        afterMarkdown: curr.md,
        diffPreview: preview,
        totalAdded,
        totalRemoved,
      },
    });
  }
}

async function handleProductPriceTarget(
  website: { id: string; url: string; domain: string },
  target: Target,
  cache: SiteScrapeCache,
  alerts: AlertInsert[],
): Promise<void> {
  if (!target.pageUrl) return;
  const page = target.pageUrl;
  const result = await extractProduct(page, { apiKey: cache.contextApiKey });
  const snap: ProductSnapshotData = {
    is_product_page: result.is_product_page,
    platform: result.platform ?? null,
    productName: result.product?.name ?? null,
    price: result.product?.price ?? null,
    currency: result.product?.currency ?? null,
  };
  const payload = JSON.stringify(snap);
  const value = { payload, hash: sha256(payload) };
  cache.product.set(page, value);

  const prev = await latestSnapshot(target.id);
  const prevData = prev ? (JSON.parse(prev.payload) as ProductSnapshotData) : null;
  const priceChanged =
    prevData !== null &&
    snap.is_product_page &&
    prevData.is_product_page &&
    priceChangeKey(prevData) !== priceChangeKey(snap);

  // The screenshot only backs the "current version" thumbnail. Refresh it on the
  // first snapshot and whenever the extracted product payload changes at all —
  // keyed off the snapshot hash, mirroring the content handler — so the thumbnail
  // can't go stale while the payload moves (name/platform/availability) even when
  // the price is unchanged. An identical check keeps the last screenshot, so a
  // quiet page doesn't spend a context.dev capture. Alert emission stays gated on
  // an actual price change below.
  if (!prev || prev.hash !== value.hash) {
    await ensurePageScreenshot(page, cache);
  }

  if (!priceChanged || !prevData) return;

  const name = snap.productName || page;
  const fmt = (p: number | null, c: string | null) =>
    p === null || p === undefined ? "—" : `${c ? `${c} ` : ""}${p}`.trim();
  alerts.push({
    id: newId("alt"),
    websiteId: website.id,
    targetId: target.id,
    kind: "PRODUCT_PRICE",
    title: `Price change: ${name} (${fmt(prevData.price, prevData.currency)} → ${fmt(snap.price, snap.currency)})`,
    details: JSON.stringify({
      pageUrl: page,
      productName: snap.productName,
      previousPrice: prevData.price,
      previousCurrency: prevData.currency,
      newPrice: snap.price,
      newCurrency: snap.currency,
    }),
    createdAt: new Date(),
  });
}

export type RunWebsiteChecksOptions = {
  /** When true (e.g. manual "Run now"), every enabled target runs regardless of schedule. */
  force?: boolean;
  /** When set, only this target is checked (manual); ignores schedule and enabled flag. */
  targetId?: string;
};

/** Pure helper: whether a target should run on this worker tick (not manual / not forced). */
export function isTargetCheckDue(
  nextCheckDueAt: Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return nextCheckDueAt == null || nowMs >= Number(nextCheckDueAt);
}

/** Advance stored deadline after success; preserves phase; collapses overdue slots without extra scrapes. */
export function computeNextCheckDueAfterSuccess(
  storedNextDueAt: Date | null | undefined,
  checkIntervalHours: number,
  nowMs: number,
): Date {
  const intervalMs = checkIntervalHours * 60 * 60 * 1000;
  const prev = storedNextDueAt != null ? Number(storedNextDueAt) : nowMs;
  let next = prev + intervalMs;
  while (next <= nowMs) {
    next += intervalMs;
  }
  return new Date(next);
}

export type RunWebsiteChecksResult = {
  alerts: number;
  errors: number;
  /** True when another run already held this website's check lock, so nothing ran. */
  skipped?: boolean;
};

/**
 * Run all enabled targets for a single website. Writes new snapshots and
 * alert rows as side effects. Runs for the same website never overlap (across
 * processes); a run that finds one already in progress is skipped, not queued.
 */
export async function runWebsiteChecks(
  websiteId: string,
  options?: RunWebsiteChecksOptions,
): Promise<RunWebsiteChecksResult> {
  const run = await withWebsiteCheckLock(websiteId, () => runWebsiteChecksLocked(websiteId, options));
  return run.acquired ? run.value : { alerts: 0, errors: 0, skipped: true };
}

async function runWebsiteChecksLocked(
  websiteId: string,
  options?: RunWebsiteChecksOptions,
): Promise<{ alerts: number; errors: number }> {
  const [website] = await db.select().from(schema.website).where(eq(schema.website.id, websiteId)).limit(1);
  if (!website) throw new Error(`website ${websiteId} not found`);

  const [userSettings] = await db
    .select({
      contextDevApiKey: schema.userNotificationSettings.contextDevApiKey,
      resendApiKey: schema.userNotificationSettings.resendApiKey,
      aiProvider: schema.userNotificationSettings.aiProvider,
      openaiApiKey: schema.userNotificationSettings.openaiApiKey,
      vercelAiGatewayApiKey: schema.userNotificationSettings.vercelAiGatewayApiKey,
      aiModel: schema.userNotificationSettings.aiModel,
    })
    .from(schema.userNotificationSettings)
    .where(eq(schema.userNotificationSettings.userId, website.userId))
    .limit(1);

  // Accounts without a settings row still get server-managed AI keys.
  const aiConfig = resolveAiSummaryConfig(userSettings);

  const userDestinations = await db
    .select({
      id: schema.notificationDestination.id,
      channel: schema.notificationDestination.channel,
      slackWebhookUrl: schema.notificationDestination.slackWebhookUrl,
      resendFromEmail: schema.notificationDestination.resendFromEmail,
      resendToEmails: schema.notificationDestination.resendToEmails,
      alertWebhookUrl: schema.notificationDestination.alertWebhookUrl,
    })
    .from(schema.notificationDestination)
    .where(eq(schema.notificationDestination.userId, website.userId));

  const contextApiKey = userSettings?.contextDevApiKey?.trim() || null;

  // Watches of revoked API clients never run (scheduled, "Run now", or manual).
  const targets = options?.targetId
    ? await db
        .select()
        .from(schema.target)
        .where(and(eq(schema.target.websiteId, websiteId), eq(schema.target.id, options.targetId), targetClientNotRevoked))
        .limit(1)
    : await db
        .select()
        .from(schema.target)
        .where(and(eq(schema.target.websiteId, websiteId), eq(schema.target.enabled, true), targetClientNotRevoked));

  const cache: SiteScrapeCache = {
    markdown: new Map(),
    product: new Map(),
    screenshot: new Map(),
    contextApiKey,
  };
  const alerts: AlertInsert[] = [];
  /** Ids of alerts actually recorded (a revoked API client's changes are dropped). */
  const committed = new Set<string>();
  const checkedTargets: Target[] = [];
  let errors = 0;
  /** Outbox rows created by this run, attempted right away at the end (the worker retries failures). */
  const newDeliveryIds: string[] = [];
  const errorThreshold = watchErrorThreshold();
  // Webhook payloads omit the callback URL: it is a credential and the receiver already knows it.
  const watchJson = (t: Target) => toWebhookWatchJson(t, website);

  const singleTarget = Boolean(options?.targetId);

  for (const t of targets) {
    if (!singleTarget && !options?.force && !isTargetCheckDue(t.nextCheckDueAt)) {
      continue;
    }
    try {
      if (t.kind === "SITEMAP_LINKS") {
        await handleLinkTarget(website, t, cache, alerts);
      } else if (t.kind === "PRODUCT_PRICE") {
        await handleProductPriceTarget(website, t, cache, alerts);
      } else {
        await handleContentTarget(website, t, cache, alerts);
      }
      // Recorded before the schedule update below: once a handler has compared against
      // the baseline (and maybe emitted an alert), the new snapshot must be stored.
      checkedTargets.push(t);
      const nowMs = Date.now();
      // Read fresh interval + deadline inside a DB transaction so a concurrent PATCH
      // cannot leave checkIntervalHours and nextCheckDueAt mismatched after we scrape.
      await db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(schema.target).where(eq(schema.target.id, t.id)).limit(1);

        if (!fresh) return;

        const nextCheckDueAt = computeNextCheckDueAfterSuccess(
          fresh.nextCheckDueAt,
          fresh.checkIntervalHours,
          nowMs,
        );

        const screenshotUrl = t.pageUrl ? cache.screenshot.get(t.pageUrl) : undefined;

        const updates = {
          lastCheckedAt: new Date(nowMs),
          nextCheckDueAt,
          lastError: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
          failingSince: null,
          ...(screenshotUrl
            ? { lastScreenshotUrl: screenshotUrl, lastScreenshotAt: new Date(nowMs) }
            : {}),
        };
        await tx.update(schema.target).set(updates).where(eq(schema.target.id, t.id));

        // A watch that had reported `watch.error` is healthy again (unless its client was
        // revoked while this check ran: then no event).
        if (
          fresh.callbackUrl &&
          fresh.apiClientId &&
          fresh.consecutiveFailures >= errorThreshold &&
          !(await lockRevokedClientIds(tx, [fresh.apiClientId])).has(fresh.apiClientId)
        ) {
          newDeliveryIds.push(
            await enqueueWebhook(tx, {
              targetId: fresh.id,
              apiClientId: fresh.apiClientId,
              url: fresh.callbackUrl,
              event: buildRecoveredEvent({
                id: newId("evt"),
                createdAt: new Date(nowMs),
                watch: watchJson({ ...fresh, ...updates }),
                failedChecks: fresh.consecutiveFailures,
                failingSince: fresh.failingSince,
              }),
            }),
          );
        }
      });
    } catch (err) {
      errors += 1;
      console.error(`target ${t.id} (${t.kind}) failed:`, err);
      // Surface the failure on the monitor and back off to the normal cadence so a
      // broken URL doesn't get retried every worker tick.
      const nowMs = Date.now();
      try {
        await db.transaction(async (tx) => {
          const [fresh] = await tx.select().from(schema.target).where(eq(schema.target.id, t.id)).limit(1);
          if (!fresh) return;
          const updates = {
            lastCheckedAt: new Date(nowMs),
            lastError: describeCheckError(err),
            lastErrorAt: new Date(nowMs),
            nextCheckDueAt: computeNextCheckDueAfterSuccess(fresh.nextCheckDueAt, fresh.checkIntervalHours, nowMs),
            consecutiveFailures: fresh.consecutiveFailures + 1,
            failingSince: fresh.failingSince ?? new Date(nowMs),
          };
          await tx.update(schema.target).set(updates).where(eq(schema.target.id, t.id));

          // Report once per failure streak, when it reaches the threshold.
          if (
            fresh.callbackUrl &&
            fresh.apiClientId &&
            updates.consecutiveFailures === errorThreshold &&
            !(await lockRevokedClientIds(tx, [fresh.apiClientId])).has(fresh.apiClientId)
          ) {
            newDeliveryIds.push(
              await enqueueWebhook(tx, {
                targetId: fresh.id,
                apiClientId: fresh.apiClientId,
                url: fresh.callbackUrl,
                event: buildErrorEvent({
                  id: newId("evt"),
                  createdAt: new Date(nowMs),
                  watch: watchJson({ ...fresh, ...updates }),
                  message: updates.lastError,
                  consecutiveFailures: updates.consecutiveFailures,
                  failingSince: updates.failingSince,
                }),
              }),
            );
          }
        });
      } catch (updateErr) {
        console.error(`failed to record error state for target ${t.id}:`, updateErr);
      }
    }
  }

  // One snapshot per checked monitor — its new diff baseline. Monitors sharing a URL
  // reuse this run's single scrape but each keeps its own baseline row.
  for (const t of checkedTargets) {
    const snap = snapshotForTarget(t, cache);
    if (!snap) continue;
    await db.insert(schema.snapshot).values({
      id: newId("snp"),
      websiteId: website.id,
      targetId: t.id,
      ...snap,
      createdAt: new Date(),
    });
  }

  if (alerts.length > 0) {
    const targetIdList = [...new Set(alerts.map((a) => a.targetId))];
    const targetRows = await db
      .select()
      .from(schema.target)
      .where(inArray(schema.target.id, targetIdList));
    const targetById = new Map(targetRows.map((t) => [t.id, t]));

    // Watch conditions: a monitor with a condition notifies only for changes that
    // satisfy it. `not_matched` is held like a filtered alert; `error` (could not
    // evaluate) is delivered, flagged, so an outage never hides a real match.
    for (const a of alerts) {
      const tgt = targetById.get(a.targetId);
      const condition = parseStoredCondition(tgt?.condition);
      if (!tgt || !condition) continue;
      a.condition = await evaluateChangeCondition({
        condition,
        intent: tgt.watchNote,
        website,
        aiConfig,
        alertKind: a.kind,
        title: a.title,
        detailsJson: a.details,
        detailsForSummary: a.summaryDetails,
      });
      if (a.condition.status === "not_matched") {
        a.suppressed = true;
        a.suppressionReason = a.condition.reason;
      }
    }

    // AI relevance filter: score each change against the monitor's watch note and
    // hold the ones judged to be noise. Runs before summarization so a held alert
    // never costs a summary call. Fails open — triageAlert returns suppress:false
    // on any misconfig, timeout, or malformed model output, so a real change is
    // never silently withheld. Monitors with a condition skip it: the condition is
    // the more specific test.
    if (aiConfig) {
      for (const a of alerts) {
        const tgt = targetById.get(a.targetId);
        if (!tgt?.aiTriageEnabled || a.condition) continue;
        const decision = await triageAlert({
          config: aiConfig,
          website,
          alertKind: a.kind,
          title: a.title,
          detailsJson: a.details,
          detailsForSummary: a.summaryDetails,
          watchNote: tgt.watchNote,
        });
        if (decision.suppress) {
          a.suppressed = true;
          a.suppressionReason = decision.reason;
        }
      }
    }

    if (aiConfig) {
      for (const a of alerts) {
        if (a.suppressed) continue;
        const tgt = targetById.get(a.targetId);
        if (!tgt) continue;
        const dests = resolveDestinationsForTarget(tgt, userDestinations);
        const hasEmailDest = dests.some((d) => d.channel === "EMAIL");
        if (!tgt.aiChangeSummaryEnabled && !hasEmailDest) continue;
        const summary = await trySummarizeAlert({
          config: aiConfig,
          website,
          alertKind: a.kind,
          title: a.title,
          detailsJson: a.details,
          detailsForSummary: a.summaryDetails,
          watchNote: tgt.watchNote,
        });
        if (summary) {
          a.details = mergeAlertDetails(a.details, { aiChangeSummary: summary });
        }
      }
    }

    const alertRows: Alert[] = alerts.map((a) => ({
      id: a.id,
      websiteId: a.websiteId,
      targetId: a.targetId,
      kind: a.kind,
      title: a.title,
      details: a.details,
      // Held alerts are recorded for the audit trail but arrive read, so they
      // stay out of unread counts and the notification pass below.
      read: Boolean(a.suppressed),
      suppressed: Boolean(a.suppressed),
      suppressionReason: a.suppressed ? (a.suppressionReason ?? null) : null,
      conditionStatus: a.condition?.status ?? null,
      conditionReason: a.condition?.reason ?? null,
      conditionEvidence: a.condition ? JSON.stringify(a.condition.evidence) : null,
      createdAt: a.createdAt,
    }));

    // `once` monitors stop after their first confirmed notification. An `error`
    // outcome was delivered unverified, so it does not use up the trigger.
    const firedTargetIds = new Set(
      alerts.filter((a) => !a.suppressed && a.condition?.status !== "error").map((a) => a.targetId),
    );
    const base = authPublicBaseUrl;

    // Alerts, `once` shutdowns, and their watch webhooks commit together: an alert is
    // never saved without its outbox row, and vice versa. Changes of watches whose API
    // client was revoked while this check ran are dropped (no event, webhook or notification);
    // the client-row lock orders this against revocation.
    await db.transaction(async (tx) => {
      const revokedClients = await lockRevokedClientIds(
        tx,
        alertRows.map((row) => targetById.get(row.targetId)?.apiClientId),
      );
      const rows = alertRows.filter((row) => {
        const clientId = targetById.get(row.targetId)?.apiClientId;
        return !clientId || !revokedClients.has(clientId);
      });
      if (rows.length === 0) return;
      await tx.insert(schema.alert).values(rows);
      for (const row of rows) committed.add(row.id);

      const triggeredAt = new Date();
      for (const id of firedTargetIds) {
        const tgt = targetById.get(id);
        if (tgt?.triggerMode !== "once" || !rows.some((r) => r.targetId === id)) continue;
        await tx.update(schema.target).set({ enabled: false, triggeredAt }).where(eq(schema.target.id, id));
        targetById.set(id, { ...tgt, enabled: false, triggeredAt });
      }

      for (const row of rows) {
        const tgt = targetById.get(row.targetId);
        if (row.suppressed || !tgt?.callbackUrl || !tgt.apiClientId) continue;
        newDeliveryIds.push(
          await enqueueWebhook(tx, {
            targetId: tgt.id,
            apiClientId: tgt.apiClientId,
            url: tgt.callbackUrl,
            event: buildTriggeredEvent({
              id: newId("evt"),
              createdAt: row.createdAt,
              watch: watchJson(tgt),
              event: toWatchEventJson(row),
              dashboardUrl: alertDashboardDeepLink(base, row.id),
            }),
          }),
        );
      }
    });

    const siteInfo = { id: website.id, name: website.name, domain: website.domain };

    const alertsByDestinationId = new Map<string, NewAlertsAlert[]>();
    for (const a of alerts) {
      if (a.suppressed || !committed.has(a.id)) continue;
      const tgt = targetById.get(a.targetId);
      if (!tgt) continue;
      const dests = resolveDestinationsForTarget(tgt, userDestinations);
      let parsedDetails: {
        diffPreview?: string;
        totalAdded?: number;
        totalRemoved?: number;
        aiChangeSummary?: string;
      } = {};
      try {
        parsedDetails = JSON.parse(a.details) as typeof parsedDetails;
      } catch {
        // ignore malformed details
      }
      const alertEntry: NewAlertsAlert = {
        id: a.id,
        targetId: a.targetId,
        title: a.title,
        diffPreview: parsedDetails.diffPreview,
        totalAdded: parsedDetails.totalAdded,
        totalRemoved: parsedDetails.totalRemoved,
        aiChangeSummary: parsedDetails.aiChangeSummary,
        ...(a.condition ? { condition: a.condition } : {}),
      };
      for (const d of dests) {
        const list = alertsByDestinationId.get(d.id) ?? [];
        list.push(alertEntry);
        alertsByDestinationId.set(d.id, list);
      }
    }

    for (const [destId, alertEntries] of alertsByDestinationId) {
      const row = userDestinations.find((d) => d.id === destId);
      if (!row) continue;
      const payload = buildNewAlertsPayload(base, siteInfo, alertEntries);
      await dispatchNewAlertsForDestinations(
        [
          {
            channel: row.channel as NotificationChannel,
            slackWebhookUrl: row.slackWebhookUrl,
            resendFromEmail: row.resendFromEmail,
            resendToEmails: row.resendToEmails,
            alertWebhookUrl: row.alertWebhookUrl,
          },
        ],
        userSettings?.resendApiKey,
        payload,
      );
    }

  }

  // First delivery attempt for this run's watch webhooks; failures stay queued and the
  // worker retries them on the backoff schedule.
  if (newDeliveryIds.length > 0) {
    try {
      await deliverDueWebhooks({ ids: newDeliveryIds });
    } catch (err) {
      console.error("immediate webhook delivery failed (will retry):", err);
    }
  }

  return { alerts: committed.size, errors };
}

export async function runAllChecks(): Promise<{
  websites: number;
  alerts: number;
  errors: number;
  /** Websites skipped because another run already held their check lock. */
  skipped: number;
}> {
  const websites = await db.select({ id: schema.website.id }).from(schema.website);
  let alerts = 0;
  let errors = 0;
  let skipped = 0;
  for (const w of websites) {
    try {
      const res = await runWebsiteChecks(w.id);
      alerts += res.alerts;
      errors += res.errors;
      if (res.skipped) skipped += 1;
    } catch (err) {
      errors += 1;
      console.error(`website ${w.id} check failed:`, err);
    }
  }
  return { websites: websites.length, alerts, errors, skipped };
}

export { parseDomain };
