/**
 * Watcher API keys: `wk_` + 32 random bytes (base64url). Keys carry 256 bits of
 * entropy, so a plain sha256 is a sufficient at-rest hash (no slow KDF needed) and
 * doubles as the lookup key.
 */

import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "wk_";
const API_KEY_PATTERN = /^wk_[A-Za-z0-9_-]{43}$/;
/** How much of the key is kept in plaintext for display ("wk_AbCdEfG…"). */
const DISPLAY_PREFIX_LENGTH = 10;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** Extract a well-formed Watcher API key from an `Authorization: Bearer …` header value. */
export function parseBearerApiKey(header: string | null | undefined): string | null {
  const m = header?.trim().match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return API_KEY_PATTERN.test(m[1]!) ? m[1]! : null;
}
