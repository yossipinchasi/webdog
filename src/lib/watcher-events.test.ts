import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildErrorEvent,
  buildRecoveredEvent,
  buildTriggeredEvent,
  isPermanentFailure,
  MAX_DELIVERY_ATTEMPTS,
  nextRetryDelayMs,
  parseWatchErrorThreshold,
  RETRY_DELAYS_MS,
  signatureHeader,
  verifySignature,
} from "./watcher-events";
import type { WatchEventJson, WatchJson } from "./v1/watch-format";

const secret = "whsec_test_secret";
const body = '{"id":"evt_1","type":"watch.triggered"}';
const t = 1_790_000_000;
const nowMs = t * 1000;

test("signature header is t=<unix>,v1=<hex HMAC-SHA256(secret, `t.body`)>", () => {
  const header = signatureHeader(secret, body, t);
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  assert.equal(header, `t=${t},v1=${expected}`);
});

test("verify: accepts a fresh, correct signature", () => {
  assert.equal(verifySignature(signatureHeader(secret, body, t), body, secret, { nowMs }), true);
  assert.equal(verifySignature(signatureHeader(secret, body, t), body, secret, { nowMs: nowMs + 299_000 }), true);
});

test("verify: rejects tampered bodies, wrong secrets, stale or future timestamps, and malformed headers", () => {
  const header = signatureHeader(secret, body, t);
  assert.equal(verifySignature(header, body.replace("evt_1", "evt_2"), secret, { nowMs }), false, "tampered body");
  assert.equal(verifySignature(header, body, "whsec_other", { nowMs }), false, "wrong secret");
  assert.equal(verifySignature(header, body, secret, { nowMs: nowMs + 301_000 }), false, "replayed after 5 minutes");
  assert.equal(verifySignature(header, body, secret, { nowMs: nowMs - 301_000 }), false, "from the future");
  const mac = header.split("v1=")[1]!;
  for (const bad of [null, "", "garbage", `t=${t}`, `v1=${mac}`, `t=abc,v1=${mac}`, `t=${t},v1=${mac.slice(2)}`, `t=${t + 1},v1=${mac}`]) {
    assert.equal(verifySignature(bad, body, secret, { nowMs }), false, String(bad));
  }
});

test("retry schedule: 30s, 2m, 10m, 30m, 1h, 3h, 6h, 12h, then give up (9 attempts)", () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 9);
  const mid = () => 0.5;
  assert.deepEqual(
    RETRY_DELAYS_MS.map((_, i) => nextRetryDelayMs(i + 1, mid)),
    [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000],
  );
  assert.equal(nextRetryDelayMs(9, mid), null);
  assert.equal(nextRetryDelayMs(0, mid), null);
});

test("retry jitter stays within ±10%", () => {
  assert.equal(nextRetryDelayMs(1, () => 0), 27_000);
  assert.equal(nextRetryDelayMs(1, () => 0.999999), 33_000);
});

test("only 410 Gone is permanent", () => {
  assert.equal(isPermanentFailure(410), true);
  for (const s of [null, 400, 401, 403, 404, 429, 500, 503]) assert.equal(isPermanentFailure(s), false, String(s));
});

test("error threshold: positive integers only, default 3", () => {
  assert.equal(parseWatchErrorThreshold("5"), 5);
  for (const raw of [undefined, null, "", "0", "-1", "2.5", "x"]) assert.equal(parseWatchErrorThreshold(raw), 3, String(raw));
});

test("event envelopes carry id, type, createdAt, and the watch", () => {
  const watch = { id: "tgt_1", externalUserId: "u1", metadata: { chat: "c" } } as unknown as WatchJson;
  const event = { id: "alt_1", type: "content_changed" } as unknown as WatchEventJson;
  const at = new Date("2026-10-01T00:00:00Z");

  const trig = buildTriggeredEvent({ id: "evt_a", createdAt: at, watch, event, dashboardUrl: "https://x/d" });
  assert.deepEqual(Object.keys(trig), ["id", "type", "createdAt", "watch", "event", "dashboardUrl"]);
  assert.equal(trig.type, "watch.triggered");
  assert.equal(trig.createdAt, "2026-10-01T00:00:00.000Z");

  const err = buildErrorEvent({ id: "evt_b", createdAt: at, watch, message: "Page not found (404).", consecutiveFailures: 3, failingSince: at });
  assert.deepEqual(err.error, { message: "Page not found (404).", consecutiveFailures: 3, failingSince: "2026-10-01T00:00:00.000Z" });

  const rec = buildRecoveredEvent({ id: "evt_c", createdAt: at, watch, failedChecks: 4, failingSince: null });
  assert.deepEqual([rec.type, rec.recovery], ["watch.recovered", { failedChecks: 4, failingSince: null }]);
});
