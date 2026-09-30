#!/usr/bin/env tsx
// Encryption-at-rest maintenance. Never prints secret values.
//   npm run secrets -- encrypt [--dry-run]   encrypt remaining plaintext credentials
//   npm run secrets -- verify                count encrypted / plaintext / undecryptable values
// The encrypt step also runs automatically in `npm run db:migrate:deploy`.
// Env: DATABASE_URL, DATA_ENCRYPTION_KEY (required in production).

import "dotenv/config";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/lib/db/database-url";
import { backfillSecrets, verifySecrets } from "../src/lib/secret-backfill";
import { currentKeyId } from "../src/lib/secret-box";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    console.log(`[secrets] current key id: ${currentKeyId()}`);
    if (command === "encrypt") {
      const dryRun = args.includes("--dry-run");
      for (const r of await backfillSecrets(client, { dryRun })) {
        console.log(`${r.column}: ${dryRun ? "would encrypt" : "encrypted"} ${r.encrypted}${r.skippedChanged ? `, skipped ${r.skippedChanged} changed concurrently` : ""}`);
      }
    } else if (command === "verify") {
      let problems = 0;
      for (const r of await verifySecrets(client)) {
        problems += r.plaintext + r.undecryptable;
        console.log(`${r.column}: encrypted ${r.encrypted}, plaintext ${r.plaintext}, undecryptable ${r.undecryptable}`);
      }
      if (problems > 0) process.exitCode = 1;
    } else {
      throw new Error("Commands: encrypt [--dry-run] | verify");
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("[secrets] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
