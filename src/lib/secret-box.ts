/**
 * Encryption at rest for stored credentials (API keys, webhook signing secrets,
 * webhook URLs that embed tokens).
 *
 * Format: `enc:v1:<keyId>:<nonce>:<ciphertext+tag>` (base64url parts)
 *  - AES-256-GCM, a fresh random 96-bit nonce per value, 128-bit auth tag.
 *  - The column's purpose (e.g. "apiClient.webhookSecret") is bound as additional
 *    authenticated data, so a ciphertext copied into another column fails to decrypt.
 *  - `keyId` is derived from the key (first 8 bytes of its SHA-256, not secret), so
 *    rotation works by setting a new DATA_ENCRYPTION_KEY and keeping the old one in
 *    DATA_ENCRYPTION_KEY_PREVIOUS until everything is re-encrypted.
 *
 * DATA_ENCRYPTION_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). Required
 * when NODE_ENV=production; otherwise a fixed development key is used (with a warning)
 * so local setups work without configuration, but only against a database on this
 * machine: the development key is public, so it must never encrypt real credentials.
 *
 * Values without the `enc:` prefix are legacy plaintext from before encryption and are
 * returned as-is so reads keep working while the backfill runs.
 *
 * Errors never include plaintext or ciphertext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const ENCRYPTED_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEV_KEY = createHash("sha256").update("webdog-development-only-data-encryption-key").digest();

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

type Keyring = { current: { id: string; key: Buffer }; byId: Map<string, Buffer> };

let cached: { env: string; ring: Keyring } | undefined;
let warnedDevKey = false;

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest().subarray(0, 8).toString("hex");
}

function parseKey(raw: string, name: string): Buffer {
  const trimmed = raw.trim();
  const encoding = trimmed.includes("-") || trimmed.includes("_") ? "base64url" : "base64";
  const key = Buffer.from(trimmed, encoding);
  // Node's base64 decoder skips invalid characters; re-encoding catches typos and non-base64 input.
  const canonical = (s: string) => s.replace(/=+$/, "");
  if (key.length !== 32 || canonical(key.toString(encoding)) !== canonical(trimmed)) {
    throw new EncryptionKeyError(`${name} must be 32 random bytes, base64-encoded (generate with: openssl rand -base64 32).`);
  }
  return key;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The development key may only be used without a database or with one on this machine. */
function databaseIsLocal(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return true;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function keyring(): Keyring {
  const currentRaw = process.env.DATA_ENCRYPTION_KEY?.trim() ?? "";
  const previousRaw = process.env.DATA_ENCRYPTION_KEY_PREVIOUS?.trim() ?? "";
  const envKey = `${currentRaw}|${previousRaw}|${process.env.NODE_ENV ?? ""}|${process.env.DATABASE_URL ?? ""}`;
  if (cached?.env === envKey) return cached.ring;

  let current: Buffer;
  if (currentRaw) {
    current = parseKey(currentRaw, "DATA_ENCRYPTION_KEY");
  } else if (process.env.NODE_ENV === "production") {
    throw new EncryptionKeyError("DATA_ENCRYPTION_KEY must be set in production (generate with: openssl rand -base64 32).");
  } else if (!databaseIsLocal()) {
    throw new EncryptionKeyError(
      "DATA_ENCRYPTION_KEY must be set when DATABASE_URL is not a local database; the development-only key is public.",
    );
  } else {
    if (!warnedDevKey) {
      console.warn("[secrets] DATA_ENCRYPTION_KEY is not set; using the development-only key. Never use this in production.");
      warnedDevKey = true;
    }
    current = DEV_KEY;
  }

  const byId = new Map<string, Buffer>([[keyIdOf(current), current]]);
  for (const raw of previousRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const key = parseKey(raw, "DATA_ENCRYPTION_KEY_PREVIOUS");
    byId.set(keyIdOf(key), key);
  }
  const ring = { current: { id: keyIdOf(current), key: current }, byId };
  cached = { env: envKey, ring };
  return ring;
}

function aad(purpose: string): Buffer {
  return Buffer.from(`webdog:${purpose}`, "utf8");
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptSecret(plaintext: string, purpose: string): string {
  const { id, key } = keyring().current;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(purpose));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${ENCRYPTED_PREFIX}${id}:${nonce.toString("base64url")}:${body.toString("base64url")}`;
}

/** Decrypt a stored value. Legacy plaintext (no `enc:` prefix) is returned unchanged. */
export function decryptSecret(stored: string, purpose: string): string {
  if (!stored.startsWith("enc:")) return stored;
  if (!isEncryptedValue(stored)) throw new SecretDecryptionError(`Cannot decrypt ${purpose}: unsupported format version.`);
  const [keyId, nonceB64, bodyB64, extra] = stored.slice(ENCRYPTED_PREFIX.length).split(":");
  if (!keyId || !nonceB64 || !bodyB64 || extra !== undefined) {
    throw new SecretDecryptionError(`Cannot decrypt ${purpose}: malformed value.`);
  }
  const key = keyring().byId.get(keyId);
  if (!key) {
    throw new SecretDecryptionError(`Cannot decrypt ${purpose}: it was encrypted with a key that is not configured (key id ${keyId}).`);
  }
  const nonce = Buffer.from(nonceB64, "base64url");
  const body = Buffer.from(bodyB64, "base64url");
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) {
    throw new SecretDecryptionError(`Cannot decrypt ${purpose}: malformed value.`);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptionError(`Cannot decrypt ${purpose}: integrity check failed (tampered data or wrong key).`);
  }
}

/**
 * Key id new values are written with (for diagnostics; not secret). Also validates the
 * key configuration, so processes call it at startup to fail fast instead of on first use.
 */
export function currentKeyId(): string {
  return keyring().current.id;
}
