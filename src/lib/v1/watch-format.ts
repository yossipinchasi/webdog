/**
 * Watcher API (`/api/v1`) contract: request schemas, the public JSON shape of a
 * watch (a monitor, i.e. a `target` row) and its events (alerts), and pagination
 * cursors. Pure — no database access — so the contract is unit-testable.
 */

import { z } from "zod";
import type { Alert, AlertKind, Target, TargetKind, WebhookDelivery, Website } from "../db/schema";
import { isValidAlertWebhookUrl } from "../notify-outbound-webhook";
import { conditionSchema, parseStoredCondition, type ConditionStatus, type WatchCondition } from "../watch-conditions";
import { isMaskedValue, maskUrl } from "../secret-mask";

export type WatchType = "page" | "price" | "links";

export const TARGET_KIND_BY_WATCH_TYPE: Record<WatchType, TargetKind> = {
  page: "PAGE_CONTENT",
  price: "PRODUCT_PRICE",
  links: "SITEMAP_LINKS",
};

export const WATCH_TYPE_BY_TARGET_KIND: Record<TargetKind, WatchType> = {
  PAGE_CONTENT: "page",
  PRODUCT_PRICE: "price",
  SITEMAP_LINKS: "links",
};

const MIN_INTERVAL_MINUTES = 15; // matches the dashboard's 0.25h minimum
const MAX_INTERVAL_MINUTES = 525_600; // 8760h, the dashboard maximum
const MAX_METADATA_BYTES = 4096;

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((s) => isValidAlertWebhookUrl(s), "Must be an absolute http(s) URL");
/** Callback URLs come back masked in responses; a masked value must never be saved as the target. */
const callbackUrl = httpUrl.refine((s) => !isMaskedValue(s), "Send the full callback URL; responses only show a masked form.");
const intervalMinutes = z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES);
const externalId = z.string().trim().min(1).max(200);
const intent = z.string().trim().max(300);
const metadata = z
  .record(z.unknown())
  .refine(
    (v) => Buffer.byteLength(JSON.stringify(v), "utf8") <= MAX_METADATA_BYTES,
    `metadata must be at most ${MAX_METADATA_BYTES} bytes of JSON`,
  );

export const createWatchSchema = z
  .object({
    url: httpUrl,
    type: z.enum(["page", "price", "links"]).default("page"),
    /** What the user wants to know about; labels the watch and steers AI triage/summaries. */
    intent: intent.optional(),
    intervalMinutes: intervalMinutes.default(1440),
    /** Receives the signed watch events (JSON POST). */
    callbackUrl: callbackUrl.optional(),
    externalUserId: externalId.optional(),
    /** Caller's id for this watch. Re-creating with the same value returns the existing watch. */
    externalRef: externalId.optional(),
    metadata: metadata.optional(),
    aiTriageEnabled: z.boolean().default(false),
    aiSummaryEnabled: z.boolean().default(false),
    /** Only notify for changes that satisfy this; omit to notify on every change. */
    condition: conditionSchema.optional(),
    /** `once` stops the watch after its first matched notification. */
    triggerMode: z.enum(["every", "once"]).default("every"),
    /** Run the first check synchronously so a bad URL is rejected at creation time. */
    baseline: z.boolean().default(true),
  })
  .strict();
export type CreateWatchInput = z.infer<typeof createWatchSchema>;

export const updateWatchSchema = z
  .object({
    intent: intent.nullable().optional(),
    intervalMinutes: intervalMinutes.optional(),
    enabled: z.boolean().optional(),
    callbackUrl: callbackUrl.nullable().optional(),
    externalUserId: externalId.nullable().optional(),
    externalRef: externalId.nullable().optional(),
    metadata: metadata.nullable().optional(),
    aiTriageEnabled: z.boolean().optional(),
    aiSummaryEnabled: z.boolean().optional(),
    condition: conditionSchema.nullable().optional(),
    triggerMode: z.enum(["every", "once"]).optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), "At least one field to update is required");
export type UpdateWatchInput = z.infer<typeof updateWatchSchema>;

const limit = z.coerce.number().int().min(1).max(100).default(50);

export const listWatchesQuerySchema = z
  .object({
    externalUserId: externalId.optional(),
    externalRef: externalId.optional(),
    type: z.enum(["page", "price", "links"]).optional(),
    enabled: z.enum(["true", "false"]).optional(),
    limit,
    cursor: z.string().optional(),
  })
  .strict();

export const listEventsQuerySchema = z
  .object({
    includeSuppressed: z.enum(["true", "false"]).default("true"),
    limit,
    cursor: z.string().optional(),
  })
  .strict();

export function minutesToHours(minutes: number): number {
  return minutes / 60;
}

export function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

export type WatchStatus = "triggered" | "paused" | "pending" | "error" | "active";

export function watchStatus(t: Pick<Target, "enabled" | "lastError" | "lastCheckedAt" | "triggeredAt">): WatchStatus {
  if (!t.enabled) return t.triggeredAt ? "triggered" : "paused";
  if (t.lastError) return "error";
  if (!t.lastCheckedAt) return "pending";
  return "active";
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export type WatchJson = {
  id: string;
  type: WatchType;
  url: string;
  intent: string | null;
  status: WatchStatus;
  enabled: boolean;
  intervalMinutes: number;
  /** Masked (`https://host/••••abcd`); the stored URL is encrypted and never returned. */
  callbackUrl: string | null;
  externalUserId: string | null;
  externalRef: string | null;
  metadata: Record<string, unknown> | null;
  aiTriageEnabled: boolean;
  aiSummaryEnabled: boolean;
  condition: WatchCondition | null;
  triggerMode: "every" | "once";
  /** When a `once` watch fired and stopped. */
  triggeredAt: string | null;
  websiteId: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
};

/** The watch as embedded in webhook payloads: no callback URL (the receiver is that URL). */
export type WebhookWatchJson = Omit<WatchJson, "callbackUrl">;

export function toWebhookWatchJson(t: Target, website: Pick<Website, "id" | "url">): WebhookWatchJson {
  const json: Partial<WatchJson> = toWatchJson(t, website, null);
  delete json.callbackUrl;
  return json as WebhookWatchJson;
}

/** `callbackUrl` should be the stored (decrypted) URL; it is masked in the result. */
export function toWatchJson(t: Target, website: Pick<Website, "id" | "url">, callbackUrl: string | null): WatchJson {
  return {
    id: t.id,
    type: WATCH_TYPE_BY_TARGET_KIND[t.kind],
    url: t.pageUrl ?? website.url,
    intent: t.watchNote,
    status: watchStatus(t),
    enabled: t.enabled,
    intervalMinutes: hoursToMinutes(t.checkIntervalHours),
    callbackUrl: maskUrl(callbackUrl),
    externalUserId: t.externalUserId,
    externalRef: t.externalRef,
    metadata: parseJsonObject(t.metadata),
    aiTriageEnabled: t.aiTriageEnabled,
    aiSummaryEnabled: t.aiChangeSummaryEnabled,
    condition: parseStoredCondition(t.condition),
    triggerMode: t.triggerMode,
    triggeredAt: iso(t.triggeredAt),
    websiteId: website.id,
    lastCheckedAt: iso(t.lastCheckedAt),
    // Null next-check = due on the next worker tick.
    nextCheckAt: t.enabled ? iso(t.nextCheckDueAt) : null,
    lastError: t.lastError,
    lastErrorAt: iso(t.lastErrorAt),
    createdAt: iso(t.createdAt)!,
  };
}

export type WatchEventType = "content_changed" | "links_added" | "links_removed" | "price_changed";

const EVENT_TYPE_BY_ALERT_KIND: Record<AlertKind, WatchEventType> = {
  PAGE_CONTENT: "content_changed",
  NEW_LINK: "links_added",
  REMOVED_LINK: "links_removed",
  PRODUCT_PRICE: "price_changed",
};

export type WatchEventJson = {
  id: string;
  watchId: string;
  type: WatchEventType;
  title: string;
  /** AI plain-language summary, when summaries ran for this change. */
  summary: string | null;
  /** True when this change was held back from notifying (condition not met, or the AI relevance filter). */
  suppressed: boolean;
  suppressionReason: string | null;
  /** How the watch's condition judged this change; null when the watch has no condition. */
  condition: { status: ConditionStatus; reason: string | null; evidence: string[] } | null;
  change: Record<string, unknown>;
  createdAt: string;
};

export function toWatchEventJson(a: Alert): WatchEventJson {
  const d = parseJsonObject(a.details) ?? {};
  let change: Record<string, unknown>;
  switch (a.kind) {
    case "PAGE_CONTENT":
      change = { pageUrl: d.pageUrl ?? null, diff: d.diffPreview ?? null, linesAdded: d.totalAdded ?? null, linesRemoved: d.totalRemoved ?? null };
      break;
    case "NEW_LINK":
      change = { added: Array.isArray(d.added) ? d.added : [] };
      break;
    case "REMOVED_LINK":
      change = { removed: Array.isArray(d.removed) ? d.removed : [] };
      break;
    case "PRODUCT_PRICE":
      change = {
        pageUrl: d.pageUrl ?? null,
        productName: d.productName ?? null,
        previousPrice: d.previousPrice ?? null,
        previousCurrency: d.previousCurrency ?? null,
        newPrice: d.newPrice ?? null,
        newCurrency: d.newCurrency ?? null,
      };
      break;
  }
  return {
    id: a.id,
    watchId: a.targetId,
    type: EVENT_TYPE_BY_ALERT_KIND[a.kind],
    title: a.title,
    summary: typeof d.aiChangeSummary === "string" ? d.aiChangeSummary : null,
    suppressed: a.suppressed,
    suppressionReason: a.suppressionReason,
    condition: a.conditionStatus
      ? { status: a.conditionStatus, reason: a.conditionReason, evidence: parseStringArray(a.conditionEvidence) }
      : null,
    change,
    createdAt: iso(a.createdAt)!,
  };
}

/** Opaque keyset cursor over (createdAt desc, id desc). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([Number(createdAt), id])).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [ms, id] = v as [unknown, unknown];
    if (typeof ms !== "number" || !Number.isFinite(ms) || typeof id !== "string" || !id) return null;
    return { createdAt: new Date(ms), id };
  } catch {
    return null;
  }
}

export type WebhookDeliveryJson = {
  id: string;
  eventId: string;
  eventType: string;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  /** When the next attempt is due; null once delivered or failed. */
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export function toWebhookDeliveryJson(d: WebhookDelivery): WebhookDeliveryJson {
  return {
    id: d.id,
    eventId: d.eventId,
    eventType: d.eventType,
    url: maskUrl(d.url)!,
    status: d.status,
    attempts: d.attempts,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    nextAttemptAt: d.status === "pending" ? iso(d.nextAttemptAt) : null,
    lastAttemptAt: iso(d.lastAttemptAt),
    deliveredAt: iso(d.deliveredAt),
    createdAt: iso(d.createdAt)!,
  };
}

export const listDeliveriesQuerySchema = z
  .object({
    status: z.enum(["pending", "delivered", "failed"]).optional(),
    limit,
    cursor: z.string().optional(),
  })
  .strict();

export const testWebhookSchema = z.object({ url: httpUrl }).strict();
