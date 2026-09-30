import { test } from "node:test";
import assert from "node:assert/strict";
import { isMaskedValue, MASK, maskSecret, maskUrl, unmaskedOr } from "./secret-mask";

// What the browser/API may see of a stored credential.

test("maskSecret keeps only the last 4 characters", () => {
  assert.equal(maskSecret("sk-proj-abcdefghijklmnop1234"), `${MASK}1234`);
  assert.equal(maskSecret("short"), MASK);
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret(undefined), null);
  assert.equal(maskSecret(""), "");
});

test("maskUrl: Slack keeps /services/ (form stays valid), hides the token path", () => {
  const m = maskUrl("https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXabcd")!;
  assert.equal(m, `https://hooks.slack.com/services/${MASK}abcd`);
  assert.ok(!m.includes("T000") && !m.includes("B000"));
});

test("maskUrl: tokens in the first segment, deeper path, query, or credentials are hidden", () => {
  assert.equal(maskUrl("https://webhook.site/3f1c2d4e-aaaa-bbbb-cccc-1234567890ab"), `https://webhook.site/${MASK}90ab`);
  assert.equal(maskUrl("https://platform.example.com/hooks/webdog?token=supersecretvalue"), `https://platform.example.com/hooks/${MASK}alue`);
  const creds = maskUrl("https://user:pass@example.com/api/x/y/z/long-secret")!;
  assert.ok(!creds.includes("user") && !creds.includes("pass"));
  assert.equal(maskUrl("https://example.com"), "https://example.com/");
  assert.equal(maskUrl("https://example.com/hooks"), "https://example.com/hooks/");
  assert.equal(maskUrl("http://127.0.0.1:4789/hook/a"), `http://127.0.0.1:4789/hook/${MASK}`);
});

test("masked values are recognizable; real values are not", () => {
  assert.ok(isMaskedValue(maskSecret("sk-abcdefghijkl")));
  assert.ok(isMaskedValue(maskUrl("https://hooks.slack.com/services/T/B/abcdefghijk")));
  assert.equal(isMaskedValue("sk-abcdefghijkl"), false);
  assert.equal(isMaskedValue(null), false);
});

test("unmaskedOr: a typed value wins; empty or masked input keeps the stored one", () => {
  assert.equal(unmaskedOr("sk-new-key-123", "sk-stored"), "sk-new-key-123");
  assert.equal(unmaskedOr(`${MASK}abcd`, "sk-stored"), "sk-stored");
  assert.equal(unmaskedOr("  ", "sk-stored"), "sk-stored");
  assert.equal(unmaskedOr(undefined, null), null);
});
