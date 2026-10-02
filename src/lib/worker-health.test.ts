import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS_GRACE_SECONDS, dueInSeconds, loopHealth, overallStatus, WEBHOOKS_GRACE_SECONDS, type LoopHealth } from "./worker-health";

// Health decisions from heartbeat rows (writes and the endpoint are tested against Postgres).

const now = new Date("2026-10-02T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const ahead = (s: number) => new Date(now.getTime() + s * 1000);
const row = (r: Partial<{ lastStartedAt: Date; lastSuccessAt: Date; lastFailureAt: Date; dueBy: Date }>) => ({
  lastStartedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  dueBy: null,
  ...r,
});

test("deadline: time to the next run plus grace, or twice a long pass", () => {
  assert.equal(dueInSeconds("checks", 10 * 60_000, 30_000), 10 * 60 + CHECKS_GRACE_SECONDS);
  assert.equal(dueInSeconds("webhooks", 10_000, 500), 10 + WEBHOOKS_GRACE_SECONDS);
  assert.equal(dueInSeconds("checks", 60_000, 40 * 60_000), 60 + 80 * 60, "a 40-minute pass gets 80 minutes");
  assert.equal(dueInSeconds("webhooks", -5_000, 0), WEBHOOKS_GRACE_SECONDS, "a past next-run counts as now");
});

test("never run, healthy, stale", () => {
  assert.equal(loopHealth(undefined, now).status, "never_run");
  assert.equal(loopHealth(row({ lastStartedAt: ago(5) }), now).status, "never_run");
  const h = loopHealth(row({ lastSuccessAt: ago(30), dueBy: ahead(90) }), now);
  assert.deepEqual([h.status, h.secondsSinceSuccess, h.staleAfter, h.lastPassFailed], ["healthy", 30, ahead(90).toISOString(), false]);
  assert.equal(loopHealth(row({ lastSuccessAt: ago(400), dueBy: ago(1) }), now).status, "stale");
  assert.equal(loopHealth(row({ lastSuccessAt: ago(400), dueBy: now }), now).status, "healthy", "exactly at the deadline is still healthy");
});

test("failures and running passes are reported, and don't make a recent success unhealthy", () => {
  const failedAfter = loopHealth(row({ lastSuccessAt: ago(60), lastFailureAt: ago(10), dueBy: ahead(60) }), now);
  assert.deepEqual([failedAfter.status, failedAfter.lastPassFailed], ["healthy", true]);
  assert.equal(loopHealth(row({ lastSuccessAt: ago(10), lastFailureAt: ago(60), dueBy: ahead(60) }), now).lastPassFailed, false);
  assert.equal(loopHealth(row({ lastFailureAt: ago(10) }), now).lastPassFailed, true, "failing from the start");
  const running = loopHealth(row({ lastSuccessAt: ago(900), lastStartedAt: ago(300), dueBy: ago(5) }), now);
  assert.deepEqual([running.status, running.runningSince], ["stale", ago(300).toISOString()], "a hung pass goes stale while it runs");
  assert.equal(loopHealth(row({ lastSuccessAt: ago(10), lastStartedAt: ago(20), dueBy: ahead(60) }), now).runningSince, null);
});

test("overall: healthy only when both loops are", () => {
  const s = (status: LoopHealth["status"]) => ({ status }) as LoopHealth;
  assert.equal(overallStatus({ checks: s("healthy"), webhooks: s("healthy") }), "healthy");
  assert.equal(overallStatus({ checks: s("healthy"), webhooks: s("stale") }), "unhealthy");
  assert.equal(overallStatus({ checks: s("stale"), webhooks: s("healthy") }), "unhealthy");
  assert.equal(overallStatus({ checks: s("healthy"), webhooks: s("never_run") }), "unhealthy");
  assert.equal(overallStatus({ checks: s("never_run"), webhooks: s("never_run") }), "never_run");
});
