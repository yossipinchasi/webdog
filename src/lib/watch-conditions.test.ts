import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conditionConfigError,
  conditionSchema,
  evaluatePriceChange,
  evaluatePriceState,
  parseStoredCondition,
  type PriceCondition,
} from "./watch-conditions";

const below200: PriceCondition = { type: "price_below", value: 200 };
const below200usd: PriceCondition = { type: "price_below", value: 200, currency: "USD" };
const usd = (price: number | null) => ({ price, currency: "USD" });

test("schema: normalizes currency, rejects bad thresholds and unknown types", () => {
  assert.deepEqual(conditionSchema.parse({ type: "price_below", value: 200, currency: " usd " }), below200usd);
  assert.deepEqual(conditionSchema.parse({ type: "intent" }), { type: "intent" });
  for (const bad of [
    { type: "price_below", value: 0 },
    { type: "price_below", value: -5 },
    { type: "price_below", value: 200, currency: "dollars" },
    { type: "price_above" },
    { type: "intent", query: "x" },
    { type: "keyword" },
  ]) {
    assert.equal(conditionSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("stored condition: unreadable values mean no condition", () => {
  assert.deepEqual(parseStoredCondition('{"type":"price_above","value":10}'), { type: "price_above", value: 10 });
  for (const raw of [null, undefined, "", "not json", '{"type":"nope"}', "[]"]) assert.equal(parseStoredCondition(raw), null);
});

test("config: price conditions only on price watches; intent needs intent text and AI", () => {
  const ok = { intent: "internship", aiConfigured: true };
  assert.equal(conditionConfigError({ condition: below200, kind: "PRODUCT_PRICE", ...ok }), null);
  assert.equal(conditionConfigError({ condition: below200, kind: "PAGE_CONTENT", ...ok })?.code, "condition_not_supported");
  assert.equal(conditionConfigError({ condition: { type: "intent" }, kind: "PAGE_CONTENT", ...ok }), null);
  assert.equal(conditionConfigError({ condition: { type: "intent" }, kind: "PAGE_CONTENT", intent: "  ", aiConfigured: true })?.code, "intent_required");
  assert.equal(conditionConfigError({ condition: { type: "intent" }, kind: "PAGE_CONTENT", intent: "x", aiConfigured: false })?.code, "ai_not_configured");
  assert.equal(conditionConfigError({ condition: below200, kind: "PRODUCT_PRICE", intent: null, aiConfigured: false }), null, "price rules need no AI");
});

test("price_below fires on the crossing only", () => {
  const cross = evaluatePriceChange(below200usd, usd(219), usd(189));
  assert.equal(cross.status, "matched");
  assert.match(cross.reason, /below USD 200.*USD 219 → USD 189/);
  assert.deepEqual(cross.evidence, ["USD 219 → USD 189"]);

  const stillBelow = evaluatePriceChange(below200usd, usd(189), usd(179));
  assert.equal(stillBelow.status, "not_matched", "already below: no re-notify");
  assert.match(stillBelow.reason, /Already below/);

  assert.equal(evaluatePriceChange(below200usd, usd(230), usd(205)).status, "not_matched", "dropped but not below");
  assert.equal(evaluatePriceChange(below200usd, usd(189), usd(210)).status, "not_matched", "rose above: not a drop");
  assert.equal(evaluatePriceChange(below200usd, usd(201), usd(200)).status, "not_matched", "strictly below");
});

test("price conditions: unknown previous price counts as not meeting; missing new price never matches", () => {
  assert.equal(evaluatePriceChange(below200, { price: null, currency: null }, usd(150)).status, "matched");
  assert.equal(evaluatePriceChange(below200, null, usd(150)).status, "matched");
  assert.equal(evaluatePriceChange(below200, usd(250), { price: null, currency: "USD" }).status, "not_matched");
});

test("currency: required currency must match; without one, any currency compares by number", () => {
  const eur = evaluatePriceChange(below200usd, { price: 250, currency: "EUR" }, { price: 150, currency: "EUR" });
  assert.equal(eur.status, "not_matched");
  assert.match(eur.reason, /in EUR, not USD/);
  assert.equal(evaluatePriceChange(below200usd, usd(250), { price: 150, currency: null }).status, "not_matched");
  assert.equal(evaluatePriceChange(below200usd, usd(250), { price: 150, currency: "usd" }).status, "matched", "case-insensitive");
  assert.equal(evaluatePriceChange(below200, { price: 250, currency: "EUR" }, { price: 150, currency: "EUR" }).status, "matched");
});

test("price_above mirrors price_below", () => {
  const above: PriceCondition = { type: "price_above", value: 100 };
  assert.equal(evaluatePriceChange(above, usd(90), usd(110)).status, "matched");
  assert.equal(evaluatePriceChange(above, usd(110), usd(120)).status, "not_matched");
  assert.equal(evaluatePriceChange(above, usd(110), usd(95)).status, "not_matched");
});

test("state (at creation): reports whether the threshold is already met", () => {
  const met = evaluatePriceState(below200usd, usd(180));
  assert.equal(met.status, "matched");
  assert.match(met.reason, /Already below USD 200: currently USD 180/);
  assert.equal(evaluatePriceState(below200usd, usd(250)).status, "not_matched");
  assert.equal(evaluatePriceState(below200usd, null).status, "not_matched");
});
