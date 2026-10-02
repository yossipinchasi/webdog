/**
 * Watcher API rate limits, per API client, stored in Postgres (no Redis).
 *
 * Every `/api/v1` request names a class (`read`, `write`, `create`, `check`, `webhook`);
 * each class has one or more rules ("N requests per window"). Counting is a fixed-window
 * counter per (client, class, window length):
 *
 *  - One statement increments only while under the limit:
 *    `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < limit`.
 *    The row lock makes concurrent requests (on any number of web replicas) serialize,
 *    so the limit is never exceeded, and rejected requests are not counted.
 *  - Window boundaries come from the database clock (`now()`), so replicas with skewed
 *    clocks agree, and a restart changes nothing.
 *  - A class with several rules (e.g. per minute and per day) is checked in one
 *    transaction: if any rule is exhausted, none is incremented.
 *  - Rows expire with their window. The worker deletes expired rows every tick, and the
 *    web app deletes a bounded batch on a small fraction of requests, so storage stays
 *    bounded by (active clients × rules) even without the worker.
 *
 * A fixed window allows up to 2× a rule's limit across a window boundary; the per-day
 * rules bound the total. Configure with RATE_LIMIT_<CLASS> (see `parseRules`).
 */

import { sql } from "drizzle-orm";
import { db } from "./db";

export type RateLimitClass = "read" | "write" | "create" | "check" | "webhook";

export type RateLimitRule = { limit: number; windowSeconds: number };

/** Defaults; override with RATE_LIMIT_<CLASS>, e.g. RATE_LIMIT_CHECK="10/1m,200/1d". */
export const DEFAULT_RULES: Record<RateLimitClass, readonly RateLimitRule[]> = {
  /** GET: list/get watches, events, deliveries. */
  read: [{ limit: 300, windowSeconds: 60 }],
  /** PATCH/DELETE a watch. */
  write: [{ limit: 60, windowSeconds: 60 }],
  /** POST /watches: a baseline scrape (and maybe AI) per call. */
  create: [
    { limit: 20, windowSeconds: 60 },
    { limit: 500, windowSeconds: 86_400 },
  ],
  /** POST /watches/:id/check: a scrape (and maybe AI) per call. */
  check: [
    { limit: 10, windowSeconds: 60 },
    { limit: 300, windowSeconds: 86_400 },
  ],
  /** POST /webhooks/test and /deliveries/:id/retry: outbound requests to caller-chosen URLs. */
  webhook: [{ limit: 10, windowSeconds: 60 }],
};

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };
const MAX_WINDOW_SECONDS = 7 * 86_400;

/**
 * Parse "limit/window[,limit/window…]", window being seconds or a number with s/m/h/d
 * ("10/1m,200/1d"); "off" disables the class. Anything invalid returns null, and the
 * caller keeps the defaults (a typo never removes protection).
 */
export function parseRules(raw: string): RateLimitRule[] | null {
  const value = raw.trim().toLowerCase();
  if (value === "off") return [];
  const rules: RateLimitRule[] = [];
  for (const part of value.split(",")) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*([smhd]?)\s*$/.exec(part);
    if (!m) return null;
    const limit = Number(m[1]);
    const windowSeconds = Number(m[2]) * UNIT_SECONDS[m[3] || "s"]!;
    if (limit < 1 || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) return null;
    rules.push({ limit, windowSeconds });
  }
  return rules.length > 0 ? rules : null;
}

const warned = new Set<string>();

/** The rules in force for a class: env override, else defaults. RATE_LIMIT_ENABLED=false disables all. */
export function rulesFor(cls: RateLimitClass, env: Record<string, string | undefined> = process.env): readonly RateLimitRule[] {
  if (env.RATE_LIMIT_ENABLED?.trim().toLowerCase() === "false") return [];
  const name = `RATE_LIMIT_${cls.toUpperCase()}`;
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RULES[cls];
  const parsed = parseRules(raw);
  if (parsed === null) {
    if (!warned.has(name)) {
      console.warn(`[rate-limit] ${name} is invalid ("limit/window[,…]", e.g. "10/1m,200/1d" or "off"); using the defaults.`);
      warned.add(name);
    }
    return DEFAULT_RULES[cls];
  }
  return parsed;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; rule: RateLimitRule; retryAfterSeconds: number; resetAt: Date };

/** Signals a denial out of the transaction so its increments roll back. */
class Denied extends Error {
  constructor(readonly decision: Extract<RateLimitDecision, { allowed: false }>) {
    super("rate limited");
  }
}

/** Fraction of allowed requests that also delete a batch of expired rows. */
const CLEANUP_PROBABILITY = 0.01;
const CLEANUP_BATCH = 1_000;

/** Count one request of `cls` for `clientId`, or report the exhausted rule. */
export async function consumeRateLimit(
  clientId: string,
  cls: RateLimitClass,
  rules: readonly RateLimitRule[] = rulesFor(cls),
): Promise<RateLimitDecision> {
  if (rules.length === 0) return { allowed: true };
  try {
    await db.transaction(async (tx) => {
      const denials: Extract<RateLimitDecision, { allowed: false }>[] = [];
      for (const rule of rules) {
        const key = `${clientId}:${cls}:${rule.windowSeconds}`;
        const w = rule.windowSeconds;
        const windowStart = sql`to_timestamp(floor(extract(epoch from now()) / ${w}) * ${w})`;
        const counted = await tx.execute<{ count: number }>(sql`
          INSERT INTO "apiRateLimit" ("key", "windowStart", "count", "expiresAt")
          VALUES (${key}, ${windowStart}, 1, ${windowStart} + make_interval(secs => ${w}))
          ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "apiRateLimit"."count" + 1
            WHERE "apiRateLimit"."count" < ${rule.limit}
          RETURNING "count"`);
        if (counted.rows.length > 0) continue;
        const reset = await tx.execute<{ resetAt: Date; seconds: number }>(sql`
          SELECT ${windowStart} + make_interval(secs => ${w}) AS "resetAt",
                 extract(epoch from (${windowStart} + make_interval(secs => ${w}) - now()))::float8 AS "seconds"`);
        const row = reset.rows[0]!;
        denials.push({ allowed: false, rule, retryAfterSeconds: Math.max(1, Math.ceil(Number(row.seconds))), resetAt: new Date(row.resetAt) });
      }
      if (denials.length > 0) {
        // The longest wait is the one that matters (e.g. the daily rule).
        throw new Denied(denials.reduce((a, b) => (b.retryAfterSeconds > a.retryAfterSeconds ? b : a)));
      }
    });
  } catch (err) {
    if (err instanceof Denied) return err.decision;
    throw err;
  }
  if (Math.random() < CLEANUP_PROBABILITY) {
    await pruneRateLimits(CLEANUP_BATCH).catch((err: unknown) => console.error("[rate-limit] cleanup failed:", err));
  }
  return { allowed: true };
}

/** Delete expired windows (at most `limit` rows). Returns how many were deleted. */
export async function pruneRateLimits(limit = 10_000): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM "apiRateLimit" WHERE ctid IN (
      SELECT ctid FROM "apiRateLimit" WHERE "expiresAt" < now() LIMIT ${limit})`);
  return res.rowCount ?? 0;
}

/** "10 per minute", "300 per day", "5 per 90 seconds". */
export function describeRule(rule: RateLimitRule): string {
  const named: Record<number, string> = { 1: "second", 60: "minute", 3_600: "hour", 86_400: "day" };
  return `${rule.limit} per ${named[rule.windowSeconds] ?? `${rule.windowSeconds} seconds`}`;
}
