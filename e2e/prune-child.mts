// Child process for the retention tests: prune with the given batch size (and report).
import { pruneWebhookDeliveries } from "../src/lib/webhook-delivery-retention";
const [days, batchSize, maxBatches] = process.argv.slice(2).map(Number);
const r = await pruneWebhookDeliveries(days!, { batchSize, maxBatches });
console.log(JSON.stringify(r));
process.exit(0);
