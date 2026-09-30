/**
 * Apply a monitor's condition to a detected change (worker) or to its current
 * snapshot (watch creation). Deterministic price conditions never call an LLM.
 */

import type { AlertKind, TargetKind, Website } from "./db/schema";
import type { AiSummaryConfig, AlertDetailsForSummary } from "./ai-change-summary";
import { matchIntentChange, matchIntentState } from "./ai-intent-match";
import { parseProductSnapshotPayload } from "./product-price-history";
import { evaluatePriceChange, evaluatePriceState, type ConditionOutcome, type WatchCondition } from "./watch-conditions";

type SiteContext = Pick<Website, "name" | "domain" | "url" | "title" | "description">;

export async function evaluateChangeCondition(params: {
  condition: WatchCondition;
  intent: string | null;
  website: SiteContext;
  aiConfig: AiSummaryConfig | null;
  alertKind: AlertKind;
  title: string;
  detailsJson: string;
  detailsForSummary?: AlertDetailsForSummary;
}): Promise<ConditionOutcome> {
  let details: AlertDetailsForSummary = params.detailsForSummary ?? {};
  if (!params.detailsForSummary) {
    try {
      details = JSON.parse(params.detailsJson) as AlertDetailsForSummary;
    } catch {
      details = {};
    }
  }

  const { condition } = params;
  if (condition.type === "intent") {
    if (!params.intent?.trim()) {
      return { status: "error", reason: "This watch has an intent condition but no intent text.", evidence: [] };
    }
    return matchIntentChange({
      config: params.aiConfig,
      intent: params.intent,
      website: params.website,
      alertKind: params.alertKind,
      title: params.title,
      details,
    });
  }

  if (params.alertKind !== "PRODUCT_PRICE") {
    return { status: "error", reason: `A ${condition.type} condition does not apply to this change.`, evidence: [] };
  }
  return evaluatePriceChange(
    condition,
    { price: details.previousPrice, currency: details.previousCurrency },
    { price: details.newPrice, currency: details.newCurrency },
  );
}

/** Whether the monitor's current snapshot already satisfies its condition. */
export async function evaluateSnapshotCondition(params: {
  condition: WatchCondition;
  kind: TargetKind;
  intent: string | null;
  website: SiteContext;
  aiConfig: AiSummaryConfig | null;
  snapshotPayload: string;
}): Promise<ConditionOutcome> {
  const { condition, kind, snapshotPayload } = params;
  const product = kind === "PRODUCT_PRICE" ? parseProductSnapshotPayload(snapshotPayload) : null;

  if (condition.type !== "intent") {
    return evaluatePriceState(condition, product ? { price: product.price, currency: product.currency } : null);
  }
  if (!params.intent?.trim()) {
    return { status: "error", reason: "This watch has an intent condition but no intent text.", evidence: [] };
  }

  let stateText = snapshotPayload;
  if (kind === "SITEMAP_LINKS") {
    try {
      stateText = `Pages on the site:\n${(JSON.parse(snapshotPayload) as string[]).join("\n")}`;
    } catch {
      // fall back to the raw payload
    }
  } else if (product) {
    stateText = [
      `Product: ${product.productName ?? "(unknown)"}`,
      `Price: ${product.price ?? "(none)"} ${product.currency ?? ""}`.trim(),
      `Is a product page: ${product.is_product_page}`,
    ].join("\n");
  }
  return matchIntentState({ config: params.aiConfig, intent: params.intent, website: params.website, stateText });
}
