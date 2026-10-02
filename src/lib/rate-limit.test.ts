import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, describeRule, parseRules, rulesFor } from "./rate-limit";
import { rateLimitedResponse } from "./v1/http";

// Rate-limit configuration and the 429 contract (counting itself is tested against Postgres).

test("parseRules: limit/window with s/m/h/d units, several rules, and off", () => {
  assert.deepEqual(parseRules("10/60"), [{ limit: 10, windowSeconds: 60 }]);
  assert.deepEqual(parseRules("10/1m, 200/1d"), [
    { limit: 10, windowSeconds: 60 },
    { limit: 200, windowSeconds: 86_400 },
  ]);
  assert.deepEqual(parseRules("5/30s,100/2h"), [
    { limit: 5, windowSeconds: 30 },
    { limit: 100, windowSeconds: 7_200 },
  ]);
  assert.deepEqual(parseRules("OFF"), []);
});

test("parseRules: anything invalid is rejected as a whole", () => {
  for (const bad of ["", "10", "ten/1m", "0/1m", "10/0", "10/1w", "10/8d", "10/1m,", "10/1m;20/1h", "-1/60"]) {
    assert.equal(parseRules(bad), null, bad);
  }
});

test("rulesFor: env override, invalid falls back to defaults, global switch", () => {
  assert.deepEqual(rulesFor("check", {}), DEFAULT_RULES.check);
  assert.deepEqual(rulesFor("check", { RATE_LIMIT_CHECK: "3/1m" }), [{ limit: 3, windowSeconds: 60 }]);
  assert.deepEqual(rulesFor("check", { RATE_LIMIT_CHECK: "lots" }), DEFAULT_RULES.check, "a typo never removes protection");
  assert.deepEqual(rulesFor("read", { RATE_LIMIT_READ: "off" }), []);
  assert.deepEqual(rulesFor("create", { RATE_LIMIT_ENABLED: "false", RATE_LIMIT_CREATE: "1/1m" }), []);
  assert.deepEqual(rulesFor("create", { RATE_LIMIT_ENABLED: "true" }), DEFAULT_RULES.create);
});

test("defaults: expensive classes are tighter than reads and have a daily cap", () => {
  const perMinute = (cls: keyof typeof DEFAULT_RULES) => DEFAULT_RULES[cls].find((r) => r.windowSeconds === 60)!.limit;
  assert.ok(perMinute("read") > perMinute("write"));
  assert.ok(perMinute("write") > perMinute("create") && perMinute("write") > perMinute("check"));
  for (const cls of ["create", "check"] as const) assert.ok(DEFAULT_RULES[cls].some((r) => r.windowSeconds === 86_400), cls);
  assert.equal(describeRule({ limit: 10, windowSeconds: 60 }), "10 per minute");
  assert.equal(describeRule({ limit: 5, windowSeconds: 90 }), "5 per 90 seconds");
});

test("429: Retry-After, RateLimit-* headers, and a machine-readable error", async () => {
  const res = rateLimitedResponse("check", {
    allowed: false,
    rule: { limit: 10, windowSeconds: 60 },
    retryAfterSeconds: 42,
    resetAt: new Date("2026-10-01T12:01:00Z"),
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "42");
  assert.equal(res.headers.get("RateLimit-Limit"), "10");
  assert.equal(res.headers.get("RateLimit-Remaining"), "0");
  assert.equal(res.headers.get("RateLimit-Reset"), "42");
  assert.equal(res.headers.get("RateLimit-Policy"), "10;w=60");
  const body = (await res.json()) as { error: { code: string; message: string; details: Record<string, unknown> } };
  assert.equal(body.error.code, "rate_limited");
  assert.match(body.error.message, /10 per minute/);
  assert.deepEqual(body.error.details, { class: "check", limit: 10, windowSeconds: 60, retryAfterSeconds: 42, resetAt: "2026-10-01T12:01:00.000Z" });
});
