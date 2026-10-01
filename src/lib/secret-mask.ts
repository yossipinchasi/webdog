/**
 * Masked forms of stored credentials for display. Decrypted secrets never leave the
 * server: responses and page props carry these masks instead, and a masked value sent
 * back unchanged means "keep the stored value". Browser-safe (no Node imports).
 */

/** U+2022 bullets; never part of a real API key or URL, so masked values are unambiguous. */
export const MASK = "••••";

export function isMaskedValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.includes(MASK);
}

/** `••••` plus the last 4 characters (just `••••` for short values). */
export function maskSecret(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return "";
  return v.length <= 8 ? MASK : `${MASK}${v.slice(-4)}`;
}

/** A path segment that is a plain word ("services", "hooks", "api"), not an identifier or token. */
const WORD_SEGMENT = /^[a-z][a-z-]{0,19}$/i;

/**
 * Scheme and host stay readable (enough to recognize the target), plus the first path
 * segment when it is a plain word (which keeps `https://hooks.slack.com/services/` valid
 * for the Slack form). Everything after, where tokens live, is masked except its last 4
 * characters. Credentials in the URL are dropped.
 */
export function maskUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return "";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return maskSecret(v);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const keepFirst = segments[0] !== undefined && WORD_SEGMENT.test(segments[0]);
  const hidden = `${(keepFirst ? segments.slice(1) : segments).join("/")}${url.search}${url.hash}`;
  const base = `${url.protocol}//${url.host}${keepFirst ? `/${segments[0]}` : ""}`;
  if (!hidden) return `${base}/`;
  return `${base}/${MASK}${hidden.length > 8 ? hidden.slice(-4) : ""}`;
}

/** A value typed in a form, unless it is empty or the masked copy of what is stored. */
export function unmaskedOr(input: string | null | undefined, stored: string | null): string | null {
  const v = input?.trim();
  return v && !isMaskedValue(v) ? v : stored;
}
