import { test } from "node:test";
import assert from "node:assert/strict";
import { generateApiKey, hashApiKey, parseBearerApiKey } from "./api-keys";

test("generated keys are well-formed, unique, and hash deterministically", () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.match(a.key, /^wk_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.key, b.key);
  assert.equal(a.keyHash, hashApiKey(a.key));
  assert.match(a.keyHash, /^[0-9a-f]{64}$/);
  assert.equal(a.keyPrefix, a.key.slice(0, 10));
  assert.ok(!a.keyHash.includes(a.key), "hash must not contain the key");
});

test("a generated key round-trips through the Bearer header parser", () => {
  const { key } = generateApiKey();
  assert.equal(parseBearerApiKey(`Bearer ${key}`), key);
  assert.equal(parseBearerApiKey(`bearer   ${key}  `), key, "scheme is case-insensitive, whitespace tolerated");
});

test("missing, malformed, or non-Watcher credentials are rejected", () => {
  const { key } = generateApiKey();
  for (const header of [
    null,
    undefined,
    "",
    key, // no scheme
    `Basic ${key}`,
    "Bearer",
    `Bearer xx_${key.slice(3)}`, // right shape, wrong prefix
    `Bearer ${key.slice(0, -1)}`, // too short
    `Bearer ${key}x`, // too long
    `Bearer ${key} extra`,
    `Bearer ${key.slice(0, 20)}!${key.slice(21)}`, // invalid character
  ]) {
    assert.equal(parseBearerApiKey(header), null, String(header));
  }
});
