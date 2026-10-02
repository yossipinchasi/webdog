// Child for the Retry-After clock test: the app clock is 1 hour behind the database.
const realNow = Date.now;
Date.now = () => realNow() - 3_600_000;
const { deliverDueWebhooks } = await import("../src/lib/webhook-outbox");
const r = await deliverDueWebhooks({ ids: [process.argv[2]!] });
console.log(JSON.stringify(r));
process.exit(0);
