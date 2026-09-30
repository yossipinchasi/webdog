import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert, Target } from "./db/schema";
import {
  createWatchSchema,
  decodeCursor,
  encodeCursor,
  listWatchesQuerySchema,
  toWatchEventJson,
  toWatchJson,
  updateWatchSchema,
  watchStatus,
} from "./v1/watch-format";

// The Watcher API contract other services build against.

function target(overrides: Partial<Target> = {}): Target {
  return {
    id: "tgt_1",
    websiteId: "web_1",
    kind: "PAGE_CONTENT",
    linkScope: null,
    pageUrl: "https://x.test/careers",
    watchNote: "investment internship",
    enabled: true,
    checkIntervalHours: 0.25,
    nextCheckDueAt: new Date("2026-01-01T00:15:00Z"),
    lastCheckedAt: new Date("2026-01-01T00:00:00Z"),
    lastError: null,
    lastErrorAt: null,
    lastScreenshotUrl: null,
    lastScreenshotAt: null,
    externalNotify: true,
    notificationDestinationId: "ndst_1",
    aiChangeSummaryEnabled: false,
    aiTriageEnabled: true,
    apiClientId: "akey_1",
    externalUserId: "user-42",
    externalRef: "watch-7",
    metadata: '{"chatId":"c1"}',
    createdAt: new Date("2025-12-31T00:00:00Z"),
    ...overrides,
  };
}

test("create: applies defaults and accepts a full body", () => {
  const min = createWatchSchema.parse({ url: "https://x.test/careers" });
  assert.equal(min.type, "page");
  assert.equal(min.intervalMinutes, 1440);
  assert.equal(min.baseline, true);
  assert.equal(min.aiTriageEnabled, false);

  const full = createWatchSchema.parse({
    url: "https://shop.test/p/1",
    type: "price",
    intent: "below $200",
    intervalMinutes: 60,
    callbackUrl: "https://platform.test/hooks/webdog",
    externalUserId: "u1",
    externalRef: "r1",
    metadata: { a: 1 },
    aiTriageEnabled: true,
    aiSummaryEnabled: true,
    baseline: false,
  });
  assert.equal(full.type, "price");
});

test("create: rejects bad URLs, intervals, unknown fields, and oversized metadata", () => {
  const bad = [
    { url: "ftp://x.test/file" },
    { url: "not a url" },
    { url: "https://x.test", intervalMinutes: 5 },
    { url: "https://x.test", intervalMinutes: 30.5 },
    { url: "https://x.test", callbackUrl: "javascript:alert(1)" },
    { url: "https://x.test", type: "auto" },
    { url: "https://x.test", condition: { type: "price_below", value: 200 } }, // Phase 2, not yet
    { url: "https://x.test", metadata: { blob: "x".repeat(5000) } },
    { url: "https://x.test", metadata: ["not", "an", "object"] },
    { url: "https://x.test", intent: "x".repeat(301) },
  ];
  for (const body of bad) assert.equal(createWatchSchema.safeParse(body).success, false, JSON.stringify(body).slice(0, 80));
});

test("update: needs at least one field; null clears nullable fields", () => {
  assert.equal(updateWatchSchema.safeParse({}).success, false);
  assert.equal(updateWatchSchema.safeParse({ enabled: false }).success, true);
  assert.deepEqual(updateWatchSchema.parse({ callbackUrl: null, metadata: null }), { callbackUrl: null, metadata: null });
  assert.equal(updateWatchSchema.safeParse({ url: "https://x.test" }).success, false, "url is immutable");
});

test("list query: coerces limit and bounds it", () => {
  assert.equal(listWatchesQuerySchema.parse({ limit: "10" }).limit, 10);
  assert.equal(listWatchesQuerySchema.parse({}).limit, 50);
  assert.equal(listWatchesQuerySchema.safeParse({ limit: "0" }).success, false);
  assert.equal(listWatchesQuerySchema.safeParse({ limit: "101" }).success, false);
});

test("status: paused > error > pending > active", () => {
  assert.equal(watchStatus({ enabled: false, lastError: "x", lastCheckedAt: null }), "paused");
  assert.equal(watchStatus({ enabled: true, lastError: "x", lastCheckedAt: new Date() }), "error");
  assert.equal(watchStatus({ enabled: true, lastError: null, lastCheckedAt: null }), "pending");
  assert.equal(watchStatus({ enabled: true, lastError: null, lastCheckedAt: new Date() }), "active");
});

test("watch JSON: maps a target to the public shape", () => {
  const w = toWatchJson(target(), { id: "web_1", url: "https://x.test" }, "https://platform.test/hook");
  assert.deepEqual(w, {
    id: "tgt_1",
    type: "page",
    url: "https://x.test/careers",
    intent: "investment internship",
    status: "active",
    enabled: true,
    intervalMinutes: 15,
    callbackUrl: "https://platform.test/hook",
    externalUserId: "user-42",
    externalRef: "watch-7",
    metadata: { chatId: "c1" },
    aiTriageEnabled: true,
    aiSummaryEnabled: false,
    websiteId: "web_1",
    lastCheckedAt: "2026-01-01T00:00:00.000Z",
    nextCheckAt: "2026-01-01T00:15:00.000Z",
    lastError: null,
    lastErrorAt: null,
    createdAt: "2025-12-31T00:00:00.000Z",
  });
});

test("watch JSON: links watches use the site URL; paused watches have no next check", () => {
  const w = toWatchJson(
    target({ kind: "SITEMAP_LINKS", pageUrl: null, enabled: false, metadata: "not json" }),
    { id: "web_1", url: "https://x.test" },
    null,
  );
  assert.equal(w.type, "links");
  assert.equal(w.url, "https://x.test");
  assert.equal(w.nextCheckAt, null);
  assert.equal(w.metadata, null, "corrupt metadata degrades to null");
});

test("event JSON: content, links, and price changes", () => {
  const base = {
    websiteId: "web_1",
    targetId: "tgt_1",
    title: "t",
    read: false,
    suppressed: false,
    suppressionReason: null,
    createdAt: new Date("2026-01-02T00:00:00Z"),
  };
  const content = toWatchEventJson({
    ...base,
    id: "alt_1",
    kind: "PAGE_CONTENT",
    details: JSON.stringify({ pageUrl: "https://x.test/careers", diffPreview: "+ Intern", totalAdded: 1, totalRemoved: 0, aiChangeSummary: "New role." }),
  } satisfies Alert);
  assert.equal(content.type, "content_changed");
  assert.equal(content.summary, "New role.");
  assert.deepEqual(content.change, { pageUrl: "https://x.test/careers", diff: "+ Intern", linesAdded: 1, linesRemoved: 0 });

  const added = toWatchEventJson({ ...base, id: "alt_2", kind: "NEW_LINK", details: '{"added":["https://x.test/a"]}' });
  assert.deepEqual([added.type, added.change], ["links_added", { added: ["https://x.test/a"] }]);

  const price = toWatchEventJson({
    ...base,
    id: "alt_3",
    kind: "PRODUCT_PRICE",
    suppressed: true,
    suppressionReason: "noise",
    details: JSON.stringify({ pageUrl: "p", productName: "W", previousPrice: 219, previousCurrency: "USD", newPrice: 189, newCurrency: "USD" }),
  });
  assert.equal(price.type, "price_changed");
  assert.equal(price.suppressed, true);
  assert.equal(price.change.newPrice, 189);
});

test("cursor: round-trips and rejects garbage", () => {
  const at = new Date("2026-03-04T05:06:07.089Z");
  assert.deepEqual(decodeCursor(encodeCursor(at, "tgt_x")), { createdAt: at, id: "tgt_x" });
  for (const bad of ["", "!!!", Buffer.from('"x"').toString("base64url"), Buffer.from("[1]").toString("base64url"), Buffer.from('["1","a"]').toString("base64url")]) {
    assert.equal(decodeCursor(bad), null, bad);
  }
});
