// Read destinations through the app's data layer (decrypting URLs) and print two of them.
const { db } = await import("../src/lib/db");
const schema = await import("../src/lib/db/schema");
const rows = await db.select().from(schema.notificationDestination);
console.log(JSON.stringify(rows.filter((r) => r.id === "ndst_D1" || r.id === "ndst_L2").map((r) => [r.id, r.alertWebhookUrl])));
process.exit(0);
