/**
 * Signed webhook events for Watcher API watches: payload shapes, HMAC signing and
 * verification, and the retry schedule. Pure — delivery lives in `webhook-outbox.ts`.
 *
 * Every request carries:
 *   X-Watcher-Event-Id:     stable across retries; receivers dedupe on it
 *   X-Watcher-Event-Type:   watch.triggered | watch.error | watch.recovered | webhook.test
 *   X-Watcher-Signature:    t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *   X-Watcher-Attempt:      1-based delivery attempt
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WatchEventJson, WebhookWatchJson as WatchJson } from "./v1/watch-format";

export type WatcherEventType = "watch.triggered" | "watch.error" | "watch.recovered";

/** Delays after each failed attempt; after the last one the delivery is marked failed. */
export const RETRY_DELAYS_MS = [
  30_000, // 30s
  2 * 60_000, // 2m
  10 * 60_000, // 10m
  30 * 60_000, // 30m
  60 * 60_000, // 1h
  3 * 60 * 60_000, // 3h
  6 * 60 * 60_000, // 6h
  12 * 60 * 60_000, // 12h
];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Receivers should reject signatures older than this (replay protection). */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Delay before the next attempt after `attemptsSoFar` failures, with ±10% jitter so a
 * receiver outage doesn't bring every retry back at once. Null when out of attempts.
 */
export function nextRetryDelayMs(attemptsSoFar: number, random: () => number = Math.random): number | null {
  const base = RETRY_DELAYS_MS[attemptsSoFar - 1];
  if (base === undefined) return null;
  return Math.round(base * (0.9 + random() * 0.2));
}

/** The longest wait before a retry; a receiver's Retry-After is capped to this. */
export const MAX_RETRY_DELAY_MS = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;

/**
 * Responses whose `Retry-After` is honored: 503 (RFC 9110) and 429 (RFC 6585). Other
 * statuses keep the normal schedule (Retry-After on a 3xx is about redirects, which are
 * never followed).
 */
export const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export type RetryAfter = { kind: "seconds"; seconds: number } | { kind: "date"; at: Date };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = `(${MONTHS.join("|")})`;
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
/** IMF-fixdate: "Sun, 06 Nov 1994 08:49:37 GMT" (the preferred form). */
const IMF_FIXDATE = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
/** Obsolete RFC 850: "Sunday, 06-Nov-94 08:49:37 GMT". */
const RFC_850 = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
/** Obsolete asctime: "Sun Nov  6 08:49:37 1994". */
const ASCTIME = new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`);

function utcDate(year: number, month: string, day: number, h: number, m: number, sec: number): Date | null {
  const mon = MONTHS.indexOf(month);
  if (h > 23 || m > 59 || sec > 60) return null;
  const date = new Date(Date.UTC(year, mon, day, h, m, Math.min(sec, 59)));
  // Reject impossible calendar dates (e.g. 31 Feb), which Date.UTC would roll over.
  return date.getUTCMonth() === mon && date.getUTCDate() === day ? date : null;
}

/**
 * Parse a `Retry-After` value strictly (RFC 9110 §10.2.3): delta-seconds (digits only)
 * or an HTTP-date in any of its three formats. Anything else, including negative or
 * fractional numbers, returns null and the normal schedule applies. Whether a date is
 * already past is decided later, against the database clock.
 */
export function parseRetryAfter(raw: string | null | undefined, nowMs: number = Date.now()): RetryAfter | null {
  const v = raw?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return { kind: "seconds", seconds: Number(v) };
  let m = IMF_FIXDATE.exec(v);
  if (m) return dateOrNull(utcDate(Number(m[3]), m[2]!, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])));
  m = RFC_850.exec(v);
  if (m) {
    // Two-digit year: the most recent year with those digits that is not more than 50 years ahead.
    const thisYear = new Date(nowMs).getUTCFullYear();
    let year = Math.floor(thisYear / 100) * 100 + Number(m[3]);
    if (year > thisYear + 50) year -= 100;
    return dateOrNull(utcDate(year, m[2]!, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])));
  }
  m = ASCTIME.exec(v);
  if (m) return dateOrNull(utcDate(Number(m[6]), m[1]!, Number(m[2]!.trim()), Number(m[3]), Number(m[4]), Number(m[5])));
  return null;
}

function dateOrNull(d: Date | null): RetryAfter | null {
  return d && !Number.isNaN(d.getTime()) ? { kind: "date", at: d } : null;
}

/** The receiver's Retry-After, when this status is one that honors it. */
export function retryAfterFor(status: number | null, raw: string | null | undefined): RetryAfter | null {
  return status !== null && RETRY_AFTER_STATUSES.has(status) ? parseRetryAfter(raw) : null;
}

/** A response that should never be retried: the receiver says the endpoint is gone. */
export function isPermanentFailure(status: number | null): boolean {
  return status === 410;
}

export function signatureHeader(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Receiver-side check (exported for tests and as a reference implementation): the
 * header must carry a fresh timestamp and a v1 HMAC over `"<t>.<raw body>"`.
 */
export function verifySignature(
  header: string | null | undefined,
  body: string,
  secret: string,
  options: { nowMs?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - t) > (options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}

type EventEnvelope<T extends string, D> = { id: string; type: T; createdAt: string } & D;

/** A change was delivered for the watch (its condition matched, or it has none). */
export type WatchTriggeredEvent = EventEnvelope<
  "watch.triggered",
  { watch: WatchJson; event: WatchEventJson; dashboardUrl: string }
>;

/** The watch's checks have been failing repeatedly. */
export type WatchErrorEvent = EventEnvelope<
  "watch.error",
  { watch: WatchJson; error: { message: string; consecutiveFailures: number; failingSince: string | null } }
>;

/** A watch that had been failing checks successfully again. */
export type WatchRecoveredEvent = EventEnvelope<
  "watch.recovered",
  { watch: WatchJson; recovery: { failedChecks: number; failingSince: string | null } }
>;

export type WatcherEvent = WatchTriggeredEvent | WatchErrorEvent | WatchRecoveredEvent;

export function buildTriggeredEvent(p: {
  id: string;
  createdAt: Date;
  watch: WatchJson;
  event: WatchEventJson;
  dashboardUrl: string;
}): WatchTriggeredEvent {
  return { id: p.id, type: "watch.triggered", createdAt: p.createdAt.toISOString(), watch: p.watch, event: p.event, dashboardUrl: p.dashboardUrl };
}

export function buildErrorEvent(p: {
  id: string;
  createdAt: Date;
  watch: WatchJson;
  message: string;
  consecutiveFailures: number;
  failingSince: Date | null;
}): WatchErrorEvent {
  return {
    id: p.id,
    type: "watch.error",
    createdAt: p.createdAt.toISOString(),
    watch: p.watch,
    error: { message: p.message, consecutiveFailures: p.consecutiveFailures, failingSince: p.failingSince?.toISOString() ?? null },
  };
}

export function buildRecoveredEvent(p: {
  id: string;
  createdAt: Date;
  watch: WatchJson;
  failedChecks: number;
  failingSince: Date | null;
}): WatchRecoveredEvent {
  return {
    id: p.id,
    type: "watch.recovered",
    createdAt: p.createdAt.toISOString(),
    watch: p.watch,
    recovery: { failedChecks: p.failedChecks, failingSince: p.failingSince?.toISOString() ?? null },
  };
}

/** Consecutive failed checks that raise `watch.error` (env WATCH_ERROR_THRESHOLD, default 3). */
export function parseWatchErrorThreshold(raw: string | null | undefined): number {
  const n = Number(raw?.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : 3;
}
