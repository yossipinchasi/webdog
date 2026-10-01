import type { Target } from "./db/schema";
import { maskUrl } from "./secret-mask";

/**
 * What the dashboard may see of a monitor: an API watch's callback URL is masked (it
 * often embeds a token), so the decrypted value never reaches the browser. The dashboard
 * never edits callback URLs, so a masked copy can't be saved back.
 */
export function publicTarget(row: Target): Target {
  return { ...row, callbackUrl: maskUrl(row.callbackUrl) };
}

/** Public share pages are unauthenticated: they get no callback URL at all. */
export function sharedTarget(row: Target): Target {
  return { ...row, callbackUrl: null };
}
