import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_DELAY_MS, parseRetryAfter, RETRY_AFTER_STATUSES, RETRY_DELAYS_MS, retryAfterFor } from "./watcher-events";

// Receiver-requested retry times (RFC 9110 §10.2.3). Scheduling itself runs in SQL on the
// database clock and is tested against Postgres.

const at = (iso: string) => ({ kind: "date", at: new Date(iso) });

test("delta-seconds: non-negative integers only", () => {
  assert.deepEqual(parseRetryAfter("120"), { kind: "seconds", seconds: 120 });
  assert.deepEqual(parseRetryAfter(" 30 "), { kind: "seconds", seconds: 30 });
  assert.deepEqual(parseRetryAfter("0"), { kind: "seconds", seconds: 0 });
  for (const bad of ["-60", "1.5", "1e3", "+5", "0x10", "12 s", "", "   ", null, undefined]) {
    assert.equal(parseRetryAfter(bad as string), null, String(bad));
  }
});

test("HTTP-date: all three formats recipients must accept", () => {
  assert.deepEqual(parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT"), at("1994-11-06T08:49:37Z"));
  assert.deepEqual(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT", Date.UTC(2026, 9, 1)), at("1994-11-06T08:49:37Z"));
  assert.deepEqual(parseRetryAfter("Thursday, 01-Oct-26 12:00:00 GMT", Date.UTC(2026, 9, 1)), at("2026-10-01T12:00:00Z"));
  assert.deepEqual(parseRetryAfter("Sun Nov  6 08:49:37 1994"), at("1994-11-06T08:49:37Z"));
  assert.deepEqual(parseRetryAfter("Thu Oct 15 09:05:00 2026"), at("2026-10-15T09:05:00Z"));
});

test("HTTP-date: strict; anything Date.parse would guess at is rejected", () => {
  for (const bad of [
    "2026-10-01",
    "2026-10-01T12:00:00Z",
    "Thu, 01 Oct 2026 12:00:00 UTC",
    "Thu, 1 Oct 2026 12:00:00 GMT",
    "Thu, 01 Oct 2026 12:00 GMT",
    "thu, 01 oct 2026 12:00:00 gmt",
    "Wed, 31 Feb 2027 00:00:00 GMT",
    "Thu, 01 Oct 2026 24:00:00 GMT",
    "Thu, 01 Foo 2026 12:00:00 GMT",
    "soon",
    "tomorrow",
  ]) {
    assert.equal(parseRetryAfter(bad), null, bad);
  }
});

test("only 429 and 503 honor Retry-After", () => {
  assert.deepEqual([...RETRY_AFTER_STATUSES].sort(), [429, 503]);
  assert.deepEqual(retryAfterFor(429, "120"), { kind: "seconds", seconds: 120 });
  assert.deepEqual(retryAfterFor(503, "120"), { kind: "seconds", seconds: 120 });
  for (const status of [500, 502, 504, 410, 408, 301, 413, 200, null]) {
    assert.equal(retryAfterFor(status, "120"), null, String(status));
  }
  assert.equal(retryAfterFor(429, null), null, "missing header");
  assert.equal(retryAfterFor(429, "garbage"), null, "malformed header");
});

test("the cap is the existing longest backoff, 12 hours", () => {
  assert.equal(MAX_RETRY_DELAY_MS, 12 * 60 * 60_000);
  assert.equal(MAX_RETRY_DELAY_MS, RETRY_DELAYS_MS.at(-1));
});
