/**
 * Watch conditions: what a detected change must satisfy before it notifies.
 *
 *   intent       — an LLM judges the change against the monitor's `watchNote`
 *                  (see `ai-intent-match.ts`).
 *   price_below  — deterministic: the product price crossed below `value`.
 *   price_above  — deterministic: the product price crossed above `value`.
 *
 * Price conditions fire on the *crossing* (previous price did not meet the
 * threshold, the new one does), so a price that stays under the line does not
 * re-notify on every small change. Pure module — no I/O.
 */

import { z } from "zod";
import type { TargetKind } from "./db/schema";

const priceThreshold = {
  value: z.number().positive().finite(),
  /** ISO 4217 code; when set, a price in any other (or unknown) currency never matches. */
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code")
    .transform((c) => c.toUpperCase())
    .optional(),
};

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("intent") }).strict(),
  z.object({ type: z.literal("price_below"), ...priceThreshold }).strict(),
  z.object({ type: z.literal("price_above"), ...priceThreshold }).strict(),
]);

export type WatchCondition = z.infer<typeof conditionSchema>;
export type PriceCondition = Extract<WatchCondition, { type: "price_below" | "price_above" }>;

export type ConditionStatus = "matched" | "not_matched" | "error";

export type ConditionOutcome = {
  status: ConditionStatus;
  reason: string;
  /** Verbatim snippets from the change supporting a match (may be empty). */
  evidence: string[];
};

/** Decode a stored `target.condition`; anything unreadable is treated as "no condition". */
export function parseStoredCondition(raw: string | null | undefined): WatchCondition | null {
  if (!raw) return null;
  try {
    const parsed = conditionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Why a condition cannot be used on this monitor, or null when it is valid.
 * `aiConfigured` is whether the owning account can make LLM calls.
 */
export function conditionConfigError(params: {
  condition: WatchCondition;
  kind: TargetKind;
  intent: string | null | undefined;
  aiConfigured: boolean;
}): { code: string; message: string } | null {
  const { condition, kind, intent, aiConfigured } = params;
  if (condition.type === "intent") {
    if (!intent?.trim()) {
      return { code: "intent_required", message: "An intent condition needs a non-empty `intent` describing what to look for." };
    }
    if (!aiConfigured) {
      return {
        code: "ai_not_configured",
        message: "Intent conditions need an AI provider. Configure OpenAI or the AI Gateway for this account first.",
      };
    }
    return null;
  }
  if (kind !== "PRODUCT_PRICE") {
    return { code: "condition_not_supported", message: `A ${condition.type} condition only applies to price watches.` };
  }
  return null;
}

export type PricePoint = { price: number | null | undefined; currency: string | null | undefined };

function formatPrice(p: PricePoint): string {
  if (p.price === null || p.price === undefined) return "no price";
  return `${p.currency ? `${p.currency} ` : ""}${p.price}`;
}

function formatThreshold(c: PriceCondition): string {
  return `${c.currency ? `${c.currency} ` : ""}${c.value}`;
}

/** Whether a single price point satisfies the threshold, or why not. */
function meets(c: PriceCondition, p: PricePoint | null): { ok: boolean; why: string } {
  if (!p || p.price === null || p.price === undefined) return { ok: false, why: "no price was found" };
  if (c.currency) {
    const cur = p.currency?.trim().toUpperCase();
    if (!cur) return { ok: false, why: `the price currency is unknown (need ${c.currency})` };
    if (cur !== c.currency) return { ok: false, why: `the price is in ${cur}, not ${c.currency}` };
  }
  const ok = c.type === "price_below" ? p.price < c.value : p.price > c.value;
  const dir = c.type === "price_below" ? "below" : "above";
  return { ok, why: ok ? "" : `${formatPrice(p)} is not ${dir} ${formatThreshold(c)}` };
}

/** Evaluate a price condition for a detected price change (crossing semantics). */
export function evaluatePriceChange(c: PriceCondition, prev: PricePoint | null, next: PricePoint): ConditionOutcome {
  const dir = c.type === "price_below" ? "below" : "above";
  const now = meets(c, next);
  if (!now.ok) return { status: "not_matched", reason: `Condition not met: ${now.why}.`, evidence: [] };
  if (meets(c, prev).ok) {
    return {
      status: "not_matched",
      reason: `Already ${dir} ${formatThreshold(c)} before this change (${formatPrice(prev!)} → ${formatPrice(next)}).`,
      evidence: [],
    };
  }
  const move = `${prev ? formatPrice(prev) : "unknown"} → ${formatPrice(next)}`;
  return { status: "matched", reason: `Price moved ${dir} ${formatThreshold(c)}: ${move}.`, evidence: [move] };
}

/** Whether the current price already satisfies the condition (used when a watch is created). */
export function evaluatePriceState(c: PriceCondition, current: PricePoint | null): ConditionOutcome {
  const dir = c.type === "price_below" ? "below" : "above";
  const r = meets(c, current);
  return r.ok
    ? { status: "matched", reason: `Already ${dir} ${formatThreshold(c)}: currently ${formatPrice(current!)}.`, evidence: [formatPrice(current!)] }
    : { status: "not_matched", reason: `Not yet: ${r.why}.`, evidence: [] };
}
