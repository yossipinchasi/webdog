import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  currentKeyId,
  decryptSecret,
  encryptSecret,
  EncryptionKeyError,
  isEncryptedValue,
  keyIdOf,
  SecretDecryptionError,
} from "./secret-box";

// AES-256-GCM at rest: confidentiality, integrity, key handling, and safe failures.

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const saved = {
  key: process.env.DATA_ENCRYPTION_KEY,
  prev: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
  env: process.env.NODE_ENV,
  db: process.env.DATABASE_URL,
};
const env = process.env as Record<string, string | undefined>;
function setKeys(current?: string, previous?: string) {
  if (current === undefined) delete env.DATA_ENCRYPTION_KEY;
  else env.DATA_ENCRYPTION_KEY = current;
  if (previous === undefined) delete env.DATA_ENCRYPTION_KEY_PREVIOUS;
  else env.DATA_ENCRYPTION_KEY_PREVIOUS = previous;
}
beforeEach(() => setKeys(keyA));
afterEach(() => {
  setKeys(saved.key, saved.prev);
  if (saved.env === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.env;
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
});

const P = "apiClient.webhookSecret";
const secret = "whsec_" + "a1".repeat(32);

test("round trip, including empty and unicode values", () => {
  for (const value of [secret, "", "sk-proj-ünïcødé-🔑", "x".repeat(10_000)]) {
    const enc = encryptSecret(value, P);
    assert.ok(isEncryptedValue(enc));
    assert.equal(decryptSecret(enc, P), value);
  }
});

test("format: enc:v1:<keyId>:<12-byte nonce>:<ciphertext+16-byte tag>, no plaintext inside", () => {
  const enc = encryptSecret(secret, P);
  const [prefix, version, keyId, nonce, body] = enc.split(":");
  assert.deepEqual([prefix, version, keyId], ["enc", "v1", keyIdOf(Buffer.from(keyA, "base64"))]);
  assert.equal(Buffer.from(nonce!, "base64url").length, 12);
  assert.equal(Buffer.from(body!, "base64url").length, Buffer.byteLength(secret) + 16);
  assert.ok(!enc.includes(secret) && !enc.includes(secret.slice(6, 20)));
});

test("randomized: same plaintext encrypts differently; nonces never repeat", () => {
  const encs = Array.from({ length: 2000 }, () => encryptSecret(secret, P));
  assert.equal(new Set(encs).size, encs.length);
  assert.equal(new Set(encs.map((e) => e.split(":")[3])).size, encs.length, "unique nonces");
  for (const e of encs.slice(0, 20)) assert.equal(decryptSecret(e, P), secret);
});

test("tampering with any part fails the integrity check", () => {
  const enc = encryptSecret(secret, P);
  const [a, b, id, nonce, body] = enc.split(":") as [string, string, string, string, string];
  const flip = (s: string, i: number) => {
    const buf = Buffer.from(s, "base64url");
    buf[i] = buf[i]! ^ 0x01;
    return buf.toString("base64url");
  };
  const bodyLen = Buffer.from(body, "base64url").length;
  const tampered = [
    [a, b, id, flip(nonce, 0), body], // nonce
    [a, b, id, nonce, flip(body, 0)], // ciphertext
    [a, b, id, nonce, flip(body, bodyLen - 1)], // auth tag
  ].map((p) => p.join(":"));
  for (const t of tampered) {
    assert.throws(() => decryptSecret(t, P), (e: Error) => e instanceof SecretDecryptionError && /integrity check failed/.test(e.message));
  }
  assert.throws(() => decryptSecret([a, b, id, nonce, body.slice(0, 10)].join(":"), P), SecretDecryptionError, "truncated");
});

test("a ciphertext moved to another column does not decrypt (purpose is authenticated)", () => {
  const enc = encryptSecret(secret, P);
  assert.throws(() => decryptSecret(enc, "userNotificationSettings.openaiApiKey"), /integrity check failed/);
});

test("wrong key: unknown key id fails; errors never contain the plaintext", () => {
  const enc = encryptSecret(secret, P);
  setKeys(keyB);
  assert.throws(
    () => decryptSecret(enc, P),
    (e: Error) => e instanceof SecretDecryptionError && /key that is not configured/.test(e.message) && !e.message.includes(secret),
  );
  // Same key id but different key material (forged id) still fails the integrity check.
  const forged = enc.replace(`:${keyIdOf(Buffer.from(keyA, "base64"))}:`, `:${currentKeyId()}:`);
  assert.throws(() => decryptSecret(forged, P), /integrity check failed/);
});

test("rotation: new writes use the new key; old ciphertexts decrypt via DATA_ENCRYPTION_KEY_PREVIOUS", () => {
  const old = encryptSecret(secret, P);
  setKeys(keyB, keyA);
  const fresh = encryptSecret(secret, P);
  assert.equal(fresh.split(":")[2], keyIdOf(Buffer.from(keyB, "base64")));
  assert.equal(decryptSecret(old, P), secret);
  assert.equal(decryptSecret(fresh, P), secret);
  setKeys(keyB);
  assert.throws(() => decryptSecret(old, P), SecretDecryptionError, "old key removed → old values unreadable");
});

test("legacy plaintext passes through; malformed or unknown versions fail", () => {
  assert.equal(decryptSecret("sk-legacy-plaintext", P), "sk-legacy-plaintext");
  assert.equal(decryptSecret("https://hooks.slack.com/services/T/B/x", P), "https://hooks.slack.com/services/T/B/x");
  for (const bad of ["enc:v2:abc:def:ghi", "enc:v1:", "enc:v1:id:nonce", "enc:v1:id:n:b:extra", "enc:v1:id:AAAA:AAAA"]) {
    assert.throws(() => decryptSecret(bad, P), SecretDecryptionError, bad);
  }
});

test("key configuration: production requires a key; keys must be 32 bytes", () => {
  setKeys(undefined);
  env.NODE_ENV = "production";
  assert.throws(() => encryptSecret(secret, P), (e: Error) => e instanceof EncryptionKeyError && /must be set in production/.test(e.message));
  env.NODE_ENV = "test";
  assert.equal(decryptSecret(encryptSecret(secret, P), P), secret, "development key outside production");
  setKeys(randomBytes(16).toString("base64"));
  assert.throws(() => encryptSecret(secret, P), (e: Error) => e instanceof EncryptionKeyError && /32 random bytes/.test(e.message));
  setKeys(keyA, "not-a-key");
  assert.throws(() => encryptSecret(secret, P), EncryptionKeyError);
});

test("key format is validated strictly: typos and non-base64 characters are rejected", () => {
  assert.equal(decryptSecret(encryptSecret(secret, P), P), secret);
  setKeys(Buffer.from(keyA, "base64").toString("base64url"));
  assert.equal(decryptSecret(encryptSecret(secret, P), P), secret, "base64url without padding is accepted");
  for (const bad of [`${keyA.slice(0, 10)}!${keyA.slice(10)}`, `${keyA.slice(0, 20)} ${keyA.slice(20)}`, Buffer.from(keyA, "base64").toString("hex")]) {
    setKeys(bad);
    assert.throws(() => encryptSecret(secret, P), EncryptionKeyError, bad.length.toString());
  }
});

test("the public development key is refused for a database that is not local", () => {
  setKeys(undefined);
  env.NODE_ENV = "development";
  for (const url of ["postgres://u:p@localhost:5432/db", "postgres://u:p@127.0.0.1/db", "postgres://u:p@[::1]/db"]) {
    env.DATABASE_URL = url;
    assert.equal(decryptSecret(encryptSecret(secret, P), P), secret, url);
  }
  const devCiphertext = encryptSecret(secret, P);
  env.DATABASE_URL = "postgres://u:p@db.example.internal:5432/prod";
  assert.throws(() => encryptSecret(secret, P), (e: Error) => e instanceof EncryptionKeyError && /not a local database/.test(e.message));
  // Production never trusts the development key, even for reading.
  setKeys(keyA);
  env.NODE_ENV = "production";
  assert.throws(() => decryptSecret(devCiphertext, P), SecretDecryptionError);
});
