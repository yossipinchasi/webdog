#!/usr/bin/env tsx
// Remove WEBHOOK destinations the pre-signed-webhooks Watcher API left behind ("API webhook (host)").
// See src/lib/legacy-webhook-cleanup.ts for exactly what qualifies.
//   npm run legacy-webhooks              dry run: list what would be removed or kept, and why
//   npm run legacy-webhooks -- --apply   remove the ones that qualify (safe to re-run)
// Env: DATABASE_URL, DATA_ENCRYPTION_KEY (required in production). Never prints URLs.

import "dotenv/config";
import { cleanupLegacyWebhookDestinations } from "../src/lib/legacy-webhook-cleanup";
import { currentKeyId } from "../src/lib/secret-box";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: [--apply]`);
  const apply = args.includes("--apply");
  currentKeyId(); // fail fast on a missing or malformed encryption key

  const items = await cleanupLegacyWebhookDestinations({ apply });
  if (items.length === 0) {
    console.log("No legacy API webhook destinations found.");
    return;
  }
  for (const i of items) {
    const action = i.removed ? "removed" : i.verdict.remove ? "would remove" : "kept";
    console.log(`${action.padEnd(12)} ${i.id}  ${i.name}  (created ${i.createdAt.toISOString()}): ${i.verdict.reason}`);
  }
  const eligible = items.filter((i) => i.verdict.remove).length;
  const removed = items.filter((i) => i.removed).length;
  console.log(
    apply
      ? `\nRemoved ${removed}; kept ${items.length - removed}.`
      : `\nDry run: ${eligible} would be removed, ${items.length - eligible} kept. Re-run with --apply to remove them.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[legacy-webhooks] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
