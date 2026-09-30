/**
 * Webhook outbox: durable, signed, retried delivery of watch events.
 *
 * Producers insert a `webhookDelivery` row in the same transaction as the change
 * that caused it (`enqueueWebhook`), so an event is never lost between "alert
 * saved" and "webhook sent". `deliverDueWebhooks` claims due rows with
 * FOR UPDATE SKIP LOCKED and a short lease — concurrent workers never send the same
 * row at the same time — then POSTs them and records the outcome, rescheduling
 * failures on the backoff in `watcher-events.ts`. A crash mid-attempt only means the
 * lease expires and the row is retried, so delivery is at-least-once; receivers
 * dedupe on the event id.
 */

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";
import { newId } from "./ids";
import { WEBHOOK_USER_AGENT } from "./product-info";
import { OutboundBlockedError, postJson } from "./outbound-guard";
import {
  isPermanentFailure,
  nextRetryDelayMs,
  parseWatchErrorThreshold,
  signatureHeader,
  type WatcherEvent,
} from "./watcher-events";

const FETCH_TIMEOUT_MS = 10_000;
/** Must comfortably exceed one batch's send time (sends run in parallel, each ≤ FETCH_TIMEOUT_MS). */
const CLAIM_LEASE_MS = 2 * 60_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCHES_PER_RUN = 10;
const MAX_ERROR_CHARS = 300;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function watchErrorThreshold(): number {
  return parseWatchErrorThreshold(process.env.WATCH_ERROR_THRESHOLD);
}

/** Queue a signed event for delivery; call inside the transaction that records its cause. */
export async function enqueueWebhook(
  tx: Tx,
  row: { targetId: string; apiClientId: string; url: string; event: WatcherEvent },
): Promise<string> {
  const id = newId("whd");
  await tx.insert(schema.webhookDelivery).values({
    id,
    eventId: row.event.id,
    eventType: row.event.type,
    targetId: row.targetId,
    apiClientId: row.apiClientId,
    url: row.url,
    payload: JSON.stringify(row.event),
    createdAt: new Date(),
  });
  return id;
}

export type SendResult = {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  /** The target is refused outright (SSRF guard); retrying cannot succeed. */
  blocked?: boolean;
};

/** One signed POST through the SSRF guard (no private targets, no redirects). Never throws. */
export async function postSignedWebhook(p: {
  url: string;
  secret: string;
  eventId: string;
  eventType: string;
  body: string;
  attempt: number;
}): Promise<SendResult> {
  try {
    const res = await postJson(p.url, p.body, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WEBHOOK_USER_AGENT,
        "X-Watcher-Event-Id": p.eventId,
        "X-Watcher-Event-Type": p.eventType,
        "X-Watcher-Attempt": String(p.attempt),
        "X-Watcher-Signature": signatureHeader(p.secret, p.body, Math.floor(Date.now() / 1000)),
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, error: null };
    const text = res.body.trim();
    const snippet = text ? `: ${text.slice(0, MAX_ERROR_CHARS)}` : "";
    return { ok: false, statusCode: res.status, error: `HTTP ${res.status}${snippet}` };
  } catch (err) {
    if (err instanceof OutboundBlockedError) {
      return { ok: false, statusCode: null, error: `Blocked: ${err.message}`.slice(0, MAX_ERROR_CHARS), blocked: true };
    }
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const message = timedOut ? "Timed out" : err instanceof Error ? err.message : String(err);
    return { ok: false, statusCode: null, error: message.slice(0, MAX_ERROR_CHARS) };
  }
}

type Claimed = typeof schema.webhookDelivery.$inferSelect;

async function claimDue(nowMs: number, limit: number, ids?: string[]): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: schema.webhookDelivery.id })
      .from(schema.webhookDelivery)
      .where(
        and(
          eq(schema.webhookDelivery.status, "pending"),
          lte(schema.webhookDelivery.nextAttemptAt, new Date(nowMs)),
          ids ? inArray(schema.webhookDelivery.id, ids) : undefined,
        ),
      )
      .orderBy(asc(schema.webhookDelivery.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(schema.webhookDelivery)
      .set({
        attempts: sql`${schema.webhookDelivery.attempts} + 1`,
        lastAttemptAt: new Date(nowMs),
        nextAttemptAt: new Date(nowMs + CLAIM_LEASE_MS),
      })
      .where(inArray(schema.webhookDelivery.id, due.map((d) => d.id)))
      .returning();
  });
}

async function recordOutcome(row: Claimed, result: SendResult, secretMissing: boolean): Promise<"delivered" | "retrying" | "failed"> {
  const nowMs = Date.now();
  if (result.ok) {
    await db
      .update(schema.webhookDelivery)
      .set({ status: "delivered", deliveredAt: new Date(nowMs), lastStatusCode: result.statusCode, lastError: null })
      .where(eq(schema.webhookDelivery.id, row.id));
    return "delivered";
  }
  const permanent = secretMissing || result.blocked || isPermanentFailure(result.statusCode);
  const delay = permanent ? null : nextRetryDelayMs(row.attempts);
  await db
    .update(schema.webhookDelivery)
    .set({
      status: delay === null ? "failed" : "pending",
      nextAttemptAt: new Date(nowMs + (delay ?? 0)),
      lastStatusCode: result.statusCode,
      lastError: result.error,
    })
    .where(eq(schema.webhookDelivery.id, row.id));
  return delay === null ? "failed" : "retrying";
}

export type DeliveryRunResult = { attempted: number; delivered: number; retrying: number; failed: number };

/**
 * Attempt every due delivery (or only `ids`, e.g. just-created ones). Safe to run
 * from several processes at once.
 */
export async function deliverDueWebhooks(options: { ids?: string[]; batchSize?: number } = {}): Promise<DeliveryRunResult> {
  const totals: DeliveryRunResult = { attempted: 0, delivered: 0, retrying: 0, failed: 0 };
  if (options.ids && options.ids.length === 0) return totals;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const claimed = await claimDue(Date.now(), batchSize, options.ids);
    if (claimed.length === 0) break;

    const clientIds = [...new Set(claimed.map((c) => c.apiClientId).filter((x): x is string => Boolean(x)))];
    const secrets = new Map(
      clientIds.length
        ? (
            await db
              .select({ id: schema.apiClient.id, secret: schema.apiClient.webhookSecret })
              .from(schema.apiClient)
              .where(inArray(schema.apiClient.id, clientIds))
          ).map((r) => [r.id, r.secret])
        : [],
    );

    const outcomes = await Promise.all(
      claimed.map(async (row) => {
        const secret = row.apiClientId ? secrets.get(row.apiClientId) : undefined;
        const result: SendResult = secret
          ? await postSignedWebhook({
              url: row.url,
              secret,
              eventId: row.eventId,
              eventType: row.eventType,
              body: row.payload,
              attempt: row.attempts,
            })
          : { ok: false, statusCode: null, error: "No signing secret: the API client for this watch no longer exists." };
        return recordOutcome(row, result, !secret);
      }),
    );

    totals.attempted += claimed.length;
    for (const o of outcomes) totals[o] += 1;
    if (claimed.length < batchSize) break;
  }
  return totals;
}

/** Put a failed (or stuck) delivery back in the queue with a fresh set of attempts. */
export async function requeueDelivery(id: string): Promise<void> {
  await db
    .update(schema.webhookDelivery)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), deliveredAt: null })
    .where(eq(schema.webhookDelivery.id, id));
}
