#!/usr/bin/env tsx
// Standalone worker process. Runs the scrape+diff pipeline for every website
// on a cron schedule. Start alongside `next dev` in a second terminal:
//   npm run worker            # long-running
//   npm run worker:once       # single pass, then exit
// Env: SCRAPE_CRON (default every 15 min), CONTEXT_DEV_API_KEY, RESEND_API_KEY,
// RESEND_SEND_FROM_EMAIL, POSTFIX_TO_ALERTS, MAX_ALERTS, SNAPSHOT_RETENTION_DAYS,
// WEBHOOK_POLL_SECONDS (default 10), WATCH_ERROR_THRESHOLD (default 3), DATABASE_URL,
// DATA_ENCRYPTION_KEY (required in production), WEBHOOK_DELIVERY_RETENTION_DAYS (default 30).

import "dotenv/config";
import cron from "node-cron";
import { runAllChecks } from "../src/lib/scraper";
import { pruneSnapshots, snapshotRetentionDays } from "../src/lib/snapshot-retention";
import { deliverDueWebhooks } from "../src/lib/webhook-outbox";
import { pruneRateLimits } from "../src/lib/rate-limit";
import { deliveryRetentionDays, pruneWebhookDeliveries } from "../src/lib/webhook-delivery-retention";
import { currentKeyId } from "../src/lib/secret-box";
import { dueInSeconds, recordPassFailure, recordPassStart, recordPassSuccess, safely } from "../src/lib/worker-health";

/** Pruning scans the snapshot table, so run it at most hourly rather than every tick. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let running = false;
let lastPruneAt = 0;
let lastDeliveryPruneAt = 0;
let delivering = false;

const DEFAULT_SCRAPE_CRON = "*/15 * * * *";
function scrapeCron(): string {
  return process.env.SCRAPE_CRON ?? DEFAULT_SCRAPE_CRON;
}

/** Milliseconds until the checks schedule next fires (for the health deadline). */
function msUntilNextCheckRun(): number {
  try {
    const probe = cron.schedule(scrapeCron(), () => {});
    const next = probe.getNextRun();
    void probe.stop();
    return next ? next.getTime() - Date.now() : 15 * 60_000;
  } catch {
    return 15 * 60_000;
  }
}

/** Send due watch webhooks (new ones that failed their first attempt, and retries). */
async function deliverWebhooks() {
  if (delivering) return;
  delivering = true;
  const started = Date.now();
  try {
    const r = await deliverDueWebhooks();
    await safely(() => recordPassSuccess("webhooks", dueInSeconds("webhooks", webhookPollMs(), Date.now() - started)));
    if (r.attempted > 0) {
      console.log(
        `[worker] webhooks: ${r.attempted} attempted — ${r.delivered} delivered, ${r.retrying} retrying, ${r.failed} failed${r.canceled ? `, ${r.canceled} canceled (client revoked)` : ""}`,
      );
    }
  } catch (err) {
    console.error("[worker] webhook delivery failed:", err);
    await safely(() => recordPassFailure("webhooks"));
  } finally {
    delivering = false;
  }
}

function webhookPollMs(): number {
  const s = Number(process.env.WEBHOOK_POLL_SECONDS);
  return Number.isFinite(s) && s >= 1 ? s * 1000 : 10_000;
}

async function pruneIfDue() {
  const days = snapshotRetentionDays();
  if (days === null || Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();
  try {
    const deleted = await pruneSnapshots(days);
    if (deleted > 0) console.log(`[worker] pruned ${deleted} snapshot(s) older than ${days} day(s)`);
  } catch (err) {
    console.error("[worker] snapshot pruning failed:", err);
  }
}

/**
 * Terminal webhook deliveries past WEBHOOK_DELIVERY_RETENTION_DAYS (default 30), at most
 * hourly. Runs on the first tick after a (re)start; safe alongside other workers.
 */
async function pruneDeliveriesIfDue() {
  const days = deliveryRetentionDays();
  if (days === null || Date.now() - lastDeliveryPruneAt < PRUNE_INTERVAL_MS) return;
  lastDeliveryPruneAt = Date.now();
  try {
    const r = await pruneWebhookDeliveries(days);
    if (r.deleted > 0) {
      console.log(
        `[worker] pruned ${r.deleted} webhook deliver${r.deleted === 1 ? "y" : "ies"} completed over ${days} day(s) ago` +
          (r.complete ? "" : " (more next run)"),
      );
    }
  } catch (err) {
    console.error("[worker] webhook delivery pruning failed:", err);
  }
}

/** Expired API rate-limit windows (the web app also prunes a batch now and then). */
async function pruneRateLimitWindows() {
  try {
    const deleted = await pruneRateLimits();
    if (deleted > 0) console.log(`[worker] pruned ${deleted} expired rate-limit window(s)`);
  } catch (err) {
    console.error("[worker] rate-limit pruning failed:", err);
  }
}

async function runOnce() {
  // A tick that outlasts the cron interval must not overlap the next one; the
  // per-website check lock also guards against other processes.
  if (running) {
    console.log(`[worker] tick ${new Date().toISOString()} skipped — previous run still in progress`);
    return;
  }
  running = true;
  const start = Date.now();
  console.log(`[worker] tick ${new Date().toISOString()}`);
  await safely(() => recordPassStart("checks"));
  try {
    const result = await runAllChecks();
    // Heartbeat: the pass went through every website (individual check errors are normal).
    await safely(() => recordPassSuccess("checks", dueInSeconds("checks", msUntilNextCheckRun(), Date.now() - start)));
    console.log(
      `[worker] done in ${Date.now() - start}ms — ${result.websites} site(s), ${result.alerts} alert(s), ${result.errors} error(s)` +
        (result.skipped > 0 ? `, ${result.skipped} site(s) skipped (check already running elsewhere)` : ""),
    );
    await pruneIfDue();
    await pruneDeliveriesIfDue();
    await pruneRateLimitWindows();
  } catch (err) {
    console.error("[worker] run failed:", err);
    await safely(() => recordPassFailure("checks"));
  } finally {
    running = false;
  }
}

async function main() {
  // Fail at startup on a missing or malformed DATA_ENCRYPTION_KEY, not on the first credential read.
  currentKeyId();
  const once = process.argv.includes("--once");
  if (once) {
    await runOnce();
    await deliverWebhooks();
    process.exit(0);
  }

  const expr = scrapeCron();
  if (!cron.validate(expr)) {
    console.error(`[worker] invalid SCRAPE_CRON: ${expr}`);
    process.exit(1);
  }

  console.log(`[worker] scheduling on "${expr}" (press Ctrl+C to stop)`);
  cron.schedule(expr, () => {
    void runOnce();
  });
  // Retries need finer timing than the scrape schedule (the first retry is after 30s).
  setInterval(() => void deliverWebhooks(), webhookPollMs());

  // Run once immediately so the first tick isn't a long wait.
  await runOnce();
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
