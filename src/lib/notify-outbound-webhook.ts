/**
 * Generic outbound webhooks: POST JSON to a user-configured URL (https or http).
 * Browser-safe (used by the dashboard for form validation); sending lives in
 * `notify-outbound-webhook.server.ts`.
 */

import { TEST_EVENT_TYPE } from "./product-info";

export function isValidAlertWebhookUrl(urlStr: string): boolean {
  const s = urlStr.trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (!u.host) return false;
    return true;
  } catch {
    return false;
  }
}

export const ALERT_WEBHOOK_TEST_BODY = {
  type: TEST_EVENT_TYPE,
  version: 1 as const,
  message: "If you receive this JSON payload, your Webhook integration is working.",
};
