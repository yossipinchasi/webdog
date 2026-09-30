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
