// Bring webdog_e2e to main's schema (0000–0006, no backfill) and seed plaintext credentials
// exactly as the pre-encryption app stored them.
import pg from "pg";
import { migrationsUpTo } from "./migrations-upto.mjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { hashPassword } from "better-auth/crypto";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { generateApiKey } from "../src/lib/api-keys";

const S = process.env.E2E_DIR!;
const rnd = () => randomBytes(9).toString("hex");
const secrets = {
  email: "e2e-owner@example.com",
  password: "e2e-password-123",
  contextDevApiKey: `test-only-contextdev-${rnd()}`,
  openaiApiKey: `test-only-openai-${rnd()}`,
  resendApiKey: `test-only-resend-${rnd()}`,
  slackWebhookUrl: `https://hooks.slack.com/services/T0LEGACY/B0LEGACY/${rnd()}`,
  alertWebhookUrl: `http://127.0.0.1:4010/recv/legacydest-${rnd()}`,
  callbackUrl: `http://127.0.0.1:4010/recv/legacycb-${rnd()}`,
  queuedUrl: `http://127.0.0.1:4010/recv/legacyqueued-${rnd()}`,
  apiKey: "",
  webhookSecret: "",
  ids: {} as Record<string, string>,
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await migrate(drizzle(client), { migrationsFolder: migrationsUpTo(6, `${S}/migrations-upto-6`) });
const now = new Date();
const ids = { user: "usr_e2e", website: "web_e2e_legacy", target: "tgt_e2e_legacy", apiClient: "akey_e2e", slack: "dst_slack", hook: "dst_hook", email: "dst_email", delivery: "whd_e2e_legacy" };
secrets.ids = ids;
await client.query(`INSERT INTO "user" (id,name,email,"emailVerified","contextIntroDismissedAt","createdAt","updatedAt") VALUES ($1,'E2E Owner',$2,true,$3,$3,$3)`, [ids.user, secrets.email, now]);
await client.query(`INSERT INTO account (id,"userId","accountId","providerId",password,"createdAt","updatedAt") VALUES ('acc_e2e',$1,$1,'credential',$2,$3,$3)`, [ids.user, await hashPassword(secrets.password), now]);
await client.query(`INSERT INTO "userNotificationSettings" ("userId","contextDevApiKey","resendApiKey","aiProvider","openaiApiKey","aiModel","updatedAt") VALUES ($1,$2,$3,'openai',$4,'gpt-fake',$5)`,
  [ids.user, secrets.contextDevApiKey, secrets.resendApiKey, secrets.openaiApiKey, now]);
await client.query(`INSERT INTO "notificationDestination" (id,"userId",channel,name,"slackWebhookUrl","createdAt") VALUES ($1,$2,'SLACK','Legacy Slack',$3,$4)`, [ids.slack, ids.user, secrets.slackWebhookUrl, now]);
await client.query(`INSERT INTO "notificationDestination" (id,"userId",channel,name,"alertWebhookUrl","createdAt") VALUES ($1,$2,'WEBHOOK','Legacy Hook',$3,$4)`, [ids.hook, ids.user, secrets.alertWebhookUrl, now]);
await client.query(`INSERT INTO "notificationDestination" (id,"userId",channel,name,"resendFromEmail","resendToEmails","createdAt") VALUES ($1,$2,'EMAIL','Legacy Email','alerts@example.com','ops@example.com',$3)`, [ids.email, ids.user, now]);
const k = generateApiKey();
secrets.apiKey = k.key;
// No webhookSecret: main's database default generates it (plaintext), as it did for real clients.
await client.query(`INSERT INTO "apiClient" (id,"ownerUserId",name,"keyPrefix","keyHash","createdAt") VALUES ($1,$2,'E2E client',$3,$4,$5)`, [ids.apiClient, ids.user, k.keyPrefix, k.keyHash, now]);
secrets.webhookSecret = (await client.query(`SELECT "webhookSecret" FROM "apiClient" WHERE id=$1`, [ids.apiClient])).rows[0].webhookSecret;
await client.query(`INSERT INTO website (id,"userId",name,url,domain,"createdAt") VALUES ($1,$2,'Legacy Shop','https://legacy-shop.example.com','legacy-shop.example.com',$3)`, [ids.website, ids.user, now]);
await client.query(`INSERT INTO target (id,"websiteId",kind,"pageUrl",enabled,"checkIntervalHours","callbackUrl","apiClientId","createdAt") VALUES ($1,$2,'PAGE_CONTENT','https://legacy-shop.example.com/news',true,24,$3,$4,$5)`, [ids.target, ids.website, secrets.callbackUrl, ids.apiClient, now]);
// A queued delivery from before the migration, payload in the old shape (with callbackUrl).
const legacyPayload = JSON.stringify({ id: "evt_e2e_legacy", type: "watch.triggered", createdAt: now.toISOString(), watch: { id: ids.target, callbackUrl: secrets.queuedUrl } });
await client.query(`INSERT INTO "webhookDelivery" (id,"eventId","eventType","targetId","apiClientId",url,payload,status,"nextAttemptAt","createdAt") VALUES ($1,'evt_e2e_legacy','watch.triggered',$2,$3,$4,$5,'pending',$6,$6)`,
  [ids.delivery, ids.target, ids.apiClient, secrets.queuedUrl, legacyPayload, now]);
writeFileSync(`${S}/secrets.json`, JSON.stringify(secrets, null, 2));
console.log("seeded; webhook secret is plaintext:", secrets.webhookSecret.startsWith("whsec_"));
await client.end();
