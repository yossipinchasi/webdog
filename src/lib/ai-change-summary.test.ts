import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { resolveAiSummaryConfig } from "./ai-change-summary";

// Server-managed AI keys must apply to every account, including ones that never
// saved Settings (no userNotificationSettings row).

const ENV_KEYS = ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "AI_MODEL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function clearAiEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("missing settings row with a server OpenAI key resolves a config", () => {
  clearAiEnv();
  process.env.OPENAI_API_KEY = "sk-server";
  for (const row of [null, undefined]) {
    const config = resolveAiSummaryConfig(row);
    assert.deepEqual(config, { provider: "openai", apiKey: "sk-server", model: "gpt-5.4-nano" });
  }
});

test("missing settings row honors server AI Gateway key and AI_MODEL", () => {
  clearAiEnv();
  process.env.AI_GATEWAY_API_KEY = "gw-server";
  process.env.AI_MODEL = "gpt-4.1-mini";
  assert.deepEqual(resolveAiSummaryConfig(null), {
    provider: "vercel_gateway",
    apiKey: "gw-server",
    model: "openai/gpt-4.1-mini",
  });
});

test("missing settings row and no server keys resolves to null", () => {
  clearAiEnv();
  assert.equal(resolveAiSummaryConfig(null), null);
  assert.equal(resolveAiSummaryConfig(undefined), null);
});

test("per-account key still works when the server has none", () => {
  clearAiEnv();
  const config = resolveAiSummaryConfig({
    aiProvider: "openai",
    openaiApiKey: "sk-account",
    vercelAiGatewayApiKey: null,
    aiModel: null,
  });
  assert.equal(config?.apiKey, "sk-account");
});
