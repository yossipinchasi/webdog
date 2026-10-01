import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadWithoutCallbackUrl } from "./secret-backfill";

// Webhook payloads queued before encryption carried a plaintext watch.callbackUrl.

test("strips watch.callbackUrl and keeps the rest of the event", () => {
  const event = {
    id: "evt_1",
    type: "watch.triggered",
    createdAt: "2026-09-30T00:00:00.000Z",
    watch: { id: "tgt_1", callbackUrl: "https://example.com/hooks/tok_secret", metadata: { callbackUrl: "user data" } },
    change: { summary: "Headline changed" },
  };
  const scrubbed = payloadWithoutCallbackUrl(JSON.stringify(event));
  assert.ok(scrubbed && !scrubbed.includes("tok_secret"));
  assert.deepEqual(JSON.parse(scrubbed!), { ...event, watch: { id: "tgt_1", metadata: { callbackUrl: "user data" } } });
});

test("leaves current payloads, other mentions, and non-JSON alone (null = no change)", () => {
  assert.equal(payloadWithoutCallbackUrl(JSON.stringify({ id: "evt_2", watch: { id: "tgt_1" } })), null);
  assert.equal(payloadWithoutCallbackUrl(JSON.stringify({ id: "evt_3", watch: { id: "t", metadata: { callbackUrl: "x" } } })), null);
  assert.equal(payloadWithoutCallbackUrl(JSON.stringify({ id: "evt_4", message: "\"callbackUrl\"" })), null);
  assert.equal(payloadWithoutCallbackUrl("not json \"callbackUrl\""), null);
  assert.equal(payloadWithoutCallbackUrl("null"), null);
});
