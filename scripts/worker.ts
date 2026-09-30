#!/usr/bin/env tsx
// Standalone worker process. Runs the scrape+diff pipeline for every website
// on a cron schedule. Start alongside `next dev` in a second terminal:
//   npm run worker            # long-running
//   npm run worker:once       # single pass, then exit
// Env: SCRAPE_CRON (default every 15 min), CONTEXT_DEV_API_KEY, RESEND_API_KEY,
// RESEND_SEND_FROM_EMAIL, POSTFIX_TO_ALERTS, MAX_ALERTS, SNAPSHOT_RETENTION_DAYS,
// WEBHOOK_POLL_SECONDS (default 10), WATCH_ERROR_THRESHOLD (default 3), DATABASE_URL.

import "dotenv/config";
import cron from "node-cron";
import { runAllChecks } from "../src/lib/scraper";
import { pruneSnapshots, snapshotRetentionDays } from "../src/lib/snapshot-retention";
import { deliverDueWebhooks } from "../src/lib/webhook-outbox";

/** Pruning scans the snapshot table, so run it at most hourly rather than every tick. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let running = false;
let lastPruneAt = 0;
let delivering = false;

/** Send due watch webhooks (new ones that failed their first attempt, and retries). */
async function deliverWebhooks() {
  if (delivering) return;
  delivering = true;
  try {
    const r = await deliverDueWebhooks();
    if (r.attempted > 0) {
      console.log(
        `[worker] webhooks: ${r.attempted} attempted — ${r.delivered} delivered, ${r.retrying} retrying, ${r.failed} failed`,
      );
    }
  } catch (err) {
    console.error("[worker] webhook delivery failed:", err);
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
  try {
    const result = await runAllChecks();
    console.log(
      `[worker] done in ${Date.now() - start}ms — ${result.websites} site(s), ${result.alerts} alert(s), ${result.errors} error(s)` +
        (result.skipped > 0 ? `, ${result.skipped} site(s) skipped (check already running elsewhere)` : ""),
    );
    await pruneIfDue();
  } catch (err) {
    console.error("[worker] run failed:", err);
  } finally {
    running = false;
  }
}

async function main() {
  const once = process.argv.includes("--once");
  if (once) {
    await runOnce();
    await deliverWebhooks();
    process.exit(0);
  }

  const expr = process.env.SCRAPE_CRON ?? "*/15 * * * *";
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
