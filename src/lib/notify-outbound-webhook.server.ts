/**
 * Sends generic outbound webhooks (dashboard WEBHOOK destinations) through the SSRF
 * guard: private/internal targets are refused, redirects are not followed.
 */

import { postJson } from "./outbound-guard";
import { WEBHOOK_USER_AGENT } from "./product-info";

const FETCH_TIMEOUT_MS = 15_000;

export async function postAlertWebhookJson(url: string, body: unknown): Promise<void> {
  const res = await postJson(url, JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "User-Agent": WEBHOOK_USER_AGENT },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`alert_webhook_http_${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
}
