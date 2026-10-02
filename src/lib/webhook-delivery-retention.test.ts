import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DELIVERY_RETENTION_DAYS, parseDeliveryRetentionDays, pruneWebhookDeliveries } from "./webhook-delivery-retention";

// Retention configuration (pruning itself is tested against Postgres).

test("retention days: default 30, positive integers, off", () => {
  assert.equal(DEFAULT_DELIVERY_RETENTION_DAYS, 30);
  assert.equal(parseDeliveryRetentionDays(undefined), 30);
  assert.equal(parseDeliveryRetentionDays(""), 30);
  assert.equal(parseDeliveryRetentionDays(" 7 "), 7);
  assert.equal(parseDeliveryRetentionDays("365"), 365);
  assert.equal(parseDeliveryRetentionDays("off"), null);
  assert.equal(parseDeliveryRetentionDays("OFF"), null);
});

test("retention days: invalid values keep the default (never delete more, never stop)", () => {
  for (const bad of ["0", "-1", "1.5", "30d", "abc", "1e3x"]) {
    assert.equal(parseDeliveryRetentionDays(bad), 30, bad);
  }
});

test("pruning refuses a non-positive or fractional retention", async () => {
  for (const bad of [0, -1, 0.5, Number.NaN]) {
    await assert.rejects(pruneWebhookDeliveries(bad), /whole number/);
  }
});
