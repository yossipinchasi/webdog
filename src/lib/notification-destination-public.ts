import type { NotificationDestination } from "./db/schema";
import { maskUrl } from "./secret-mask";
import { isResendSendFromEmailManagedByEnv } from "./server-managed-config";

export type PublicNotificationDestination = NotificationDestination;

/**
 * What the dashboard may see of a destination: webhook URLs are masked (they embed
 * tokens), so decrypted values never reach the browser. Saving a masked URL unchanged
 * keeps the stored one.
 */
export function publicNotificationDestination(
  row: NotificationDestination,
): PublicNotificationDestination {
  const masked = { ...row, slackWebhookUrl: maskUrl(row.slackWebhookUrl), alertWebhookUrl: maskUrl(row.alertWebhookUrl) };
  if (isResendSendFromEmailManagedByEnv() && row.channel === "EMAIL") {
    return { ...masked, resendFromEmail: null };
  }
  return masked;
}

export function publicNotificationDestinations(
  rows: NotificationDestination[],
): PublicNotificationDestination[] {
  return rows.map(publicNotificationDestination);
}
