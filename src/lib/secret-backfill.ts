/**
 * Encrypts credentials that were stored as plaintext before encryption at rest existed.
 *
 * Safety properties (each row is handled independently):
 *  - Verify before write: every new ciphertext is decrypted and compared with the
 *    original before it is stored, so a misconfigured key can never replace a working
 *    value with one that won't decrypt.
 *  - Compare-and-set: `UPDATE … WHERE pk = $pk AND col = $plaintext` only replaces the
 *    exact value that was read; a value changed concurrently (e.g. a user saving a new
 *    key) is left alone.
 *  - Idempotent and resumable: already-encrypted values are skipped, each update is a
 *    single atomic statement, so an interrupted run leaves every row either fully
 *    plaintext or fully encrypted, and simply running again finishes the job.
 *
 * Old row versions may survive in Postgres dead tuples, WAL, and backups until they are
 * vacuumed/expire; rotate a credential if its prior plaintext exposure matters.
 */

import type pg from "pg";
import { decryptSecret, encryptSecret, ENCRYPTED_PREFIX, SecretDecryptionError } from "./secret-box";

export type SecretColumn = { table: string; pk: string; column: string; purpose: string };

/** Every encrypted column; purposes must match the schema's `encryptedText(...)` calls. */
export const SECRET_COLUMNS: readonly SecretColumn[] = [
  { table: "apiClient", pk: "id", column: "webhookSecret", purpose: "apiClient.webhookSecret" },
  { table: "userNotificationSettings", pk: "userId", column: "contextDevApiKey", purpose: "userNotificationSettings.contextDevApiKey" },
  { table: "userNotificationSettings", pk: "userId", column: "resendApiKey", purpose: "userNotificationSettings.resendApiKey" },
  { table: "userNotificationSettings", pk: "userId", column: "openaiApiKey", purpose: "userNotificationSettings.openaiApiKey" },
  { table: "userNotificationSettings", pk: "userId", column: "vercelAiGatewayApiKey", purpose: "userNotificationSettings.vercelAiGatewayApiKey" },
  { table: "notificationDestination", pk: "id", column: "slackWebhookUrl", purpose: "notificationDestination.slackWebhookUrl" },
  { table: "notificationDestination", pk: "id", column: "alertWebhookUrl", purpose: "notificationDestination.alertWebhookUrl" },
  { table: "target", pk: "id", column: "callbackUrl", purpose: "target.callbackUrl" },
  { table: "webhookDelivery", pk: "id", column: "url", purpose: "webhookDelivery.url" },
];

const BATCH = 500;
/** Stop if a column keeps yielding plaintext (e.g. an old app version still writing it). */
const MAX_ROUNDS_PER_COLUMN = 1_000;

export type BackfillColumnResult = { column: string; encrypted: number; skippedChanged: number };

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Encrypt every remaining plaintext value. With `dryRun`, only counts them. */
export async function backfillSecrets(
  client: pg.Client | pg.PoolClient,
  options: { dryRun?: boolean; onRow?: (col: SecretColumn) => void } = {},
): Promise<BackfillColumnResult[]> {
  const results: BackfillColumnResult[] = [];
  for (const col of SECRET_COLUMNS) {
    const result: BackfillColumnResult = { column: `${col.table}.${col.column}`, encrypted: 0, skippedChanged: 0 };
    const selectSql = `SELECT ${q(col.pk)} AS pk, ${q(col.column)} AS value FROM ${q(col.table)}
      WHERE ${q(col.column)} IS NOT NULL AND ${q(col.column)} NOT LIKE '${ENCRYPTED_PREFIX}%'
      ORDER BY ${q(col.pk)} LIMIT ${BATCH}`;

    if (options.dryRun) {
      const count = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${q(col.table)} WHERE ${q(col.column)} IS NOT NULL AND ${q(col.column)} NOT LIKE '${ENCRYPTED_PREFIX}%'`,
      );
      result.encrypted = count.rows[0]?.n ?? 0;
      results.push(result);
      continue;
    }

    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS_PER_COLUMN) {
        throw new Error(`Backfill of ${result.column} did not converge; is an older app version still writing plaintext?`);
      }
      const rows = (await client.query<{ pk: string; value: string }>(selectSql)).rows;
      if (rows.length === 0) break;
      let progressed = 0;
      for (const row of rows) {
        const encrypted = encryptSecret(row.value, col.purpose);
        if (decryptSecret(encrypted, col.purpose) !== row.value) {
          throw new Error(`Backfill self-check failed for ${result.column}; nothing was written for this value.`);
        }
        const res = await client.query(
          `UPDATE ${q(col.table)} SET ${q(col.column)} = $1 WHERE ${q(col.pk)} = $2 AND ${q(col.column)} = $3`,
          [encrypted, row.pk, row.value],
        );
        if (res.rowCount === 1) {
          result.encrypted += 1;
          progressed += 1;
          options.onRow?.(col);
        } else {
          result.skippedChanged += 1;
        }
      }
      // Every row in this batch changed underneath us; re-read (they are encrypted now or will be picked up).
      if (progressed === 0 && rows.length < BATCH) break;
    }
    results.push(result);
  }
  return results;
}

export type VerifyColumnResult = { column: string; encrypted: number; plaintext: number; undecryptable: number };

/** Count encrypted, still-plaintext, and undecryptable values per column (never prints values). */
export async function verifySecrets(client: pg.Client | pg.PoolClient): Promise<VerifyColumnResult[]> {
  const results: VerifyColumnResult[] = [];
  for (const col of SECRET_COLUMNS) {
    const result: VerifyColumnResult = { column: `${col.table}.${col.column}`, encrypted: 0, plaintext: 0, undecryptable: 0 };
    const rows = (await client.query<{ value: string }>(`SELECT ${q(col.column)} AS value FROM ${q(col.table)} WHERE ${q(col.column)} IS NOT NULL`)).rows;
    for (const { value } of rows) {
      if (!value.startsWith(ENCRYPTED_PREFIX)) {
        result.plaintext += 1;
        continue;
      }
      try {
        decryptSecret(value, col.purpose);
        result.encrypted += 1;
      } catch (err) {
        if (!(err instanceof SecretDecryptionError)) throw err;
        result.undecryptable += 1;
      }
    }
    results.push(result);
  }
  return results;
}
