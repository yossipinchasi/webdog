// The immediate send must pick up a just-queued delivery even when the app clock is behind the DB clock.
import pg from "pg";
import { encryptSecret } from "../src/lib/secret-box";
const realNow = Date.now;
Date.now = () => realNow() - 5_000; // app clock 5s behind the database
const { deliverDueWebhooks } = await import("../src/lib/webhook-outbox");
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const id = `whd_clock_${realNow()}`;
const tok = `clock-${realNow()}`;
await c.query(`INSERT INTO "webhookDelivery" (id,"eventId","eventType","apiClientId",url,payload,"createdAt") VALUES ($1,$1,'watch.triggered','akey_e2e',$2,'{}',now())`,
  [id, encryptSecret(`http://127.0.0.1:4010/recv/${tok}`, "webhookDelivery.url")]);
const r = await deliverDueWebhooks({ ids: [id] });
const row = (await c.query(`SELECT status, attempts FROM "webhookDelivery" WHERE id=$1`, [id])).rows[0];
await c.query(`DELETE FROM "webhookDelivery" WHERE id=$1`, [id]);
await c.end();
console.log(JSON.stringify({ attempted: r.attempted, status: row.status, attempts: row.attempts }));
process.exit(r.attempted === 1 && row.status === "delivered" ? 0 : 1);
