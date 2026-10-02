// Child for the worker-health clock test: the app clock is skewed by argv[2] ms.
const realNow = Date.now;
const skew = Number(process.argv[2]);
Date.now = () => realNow() + skew;
const h = await import("../src/lib/worker-health");
if (process.argv[3] === "write") await h.recordPassSuccess("webhooks", h.dueInSeconds("webhooks", 10_000, 100));
console.log(JSON.stringify(await h.getWorkerHealth()));
process.exit(0);
