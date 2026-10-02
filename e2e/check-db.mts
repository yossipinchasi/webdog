// Every encrypted column: is it ciphertext, does it decrypt to the original? Writes a snapshot.
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { decryptSecret } from "../src/lib/secret-box";
import { SECRET_COLUMNS } from "../src/lib/secret-backfill";
const S = process.env.E2E_DIR!;
const secrets = JSON.parse(readFileSync(`${S}/secrets.json`, "utf8"));
const expected: Record<string, string> = {
  "apiClient.webhookSecret": secrets.webhookSecret,
  "userNotificationSettings.contextDevApiKey": secrets.contextDevApiKey,
  "userNotificationSettings.openaiApiKey": secrets.openaiApiKey,
  "userNotificationSettings.resendApiKey": secrets.resendApiKey,
  "notificationDestination.slackWebhookUrl": secrets.slackWebhookUrl,
  "notificationDestination.alertWebhookUrl": secrets.alertWebhookUrl,
  "target.callbackUrl": secrets.callbackUrl,
  "webhookDelivery.url": secrets.queuedUrl,
};
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const snapshot: Record<string, string> = {};
let plaintext = 0, bad = 0, legacyMatched = 0;
for (const col of SECRET_COLUMNS) {
  const rows = (await c.query(`SELECT "${col.pk}" AS pk, "${col.column}" AS v FROM "${col.table}" WHERE "${col.column}" IS NOT NULL`)).rows;
  for (const { pk, v } of rows) {
    snapshot[`${col.purpose}#${pk}`] = v;
    if (!v.startsWith("enc:v1:")) { plaintext++; console.log(`PLAINTEXT ${col.purpose}#${pk}`); continue; }
    const d = decryptSecret(v, col.purpose);
    if (expected[col.purpose] !== undefined && [secrets.ids.user, secrets.ids.apiClient, secrets.ids.slack, secrets.ids.hook, secrets.ids.target, secrets.ids.delivery].includes(pk)) {
      if (d === expected[col.purpose]) legacyMatched++; else { bad++; console.log(`MISMATCH ${col.purpose}#${pk}`); }
    }
  }
}
const def = (await c.query(`SELECT column_default FROM information_schema.columns WHERE table_name='apiClient' AND column_name='webhookSecret'`)).rows[0].column_default;
const out = process.argv[2];
if (out) writeFileSync(`${S}/${out}`, JSON.stringify(snapshot));
console.log(JSON.stringify({ values: Object.keys(snapshot).length, plaintext, mismatches: bad, legacyDecryptedToOriginal: legacyMatched, webhookSecretDefault: def }));
await c.end();
if (plaintext > 0 || bad > 0 || legacyMatched !== 8 || def !== null) process.exit(1);
