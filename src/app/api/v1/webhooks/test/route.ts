import { NextResponse } from "next/server";
import { newId } from "@/lib/ids";
import { authenticateApiClient, parseV1Json, v1Error } from "@/lib/v1/http";
import { checkOutboundUrl } from "@/lib/outbound-guard";
import { testWebhookSchema } from "@/lib/v1/watch-format";
import { postSignedWebhook } from "@/lib/webhook-outbox";

/**
 * Send one signed `webhook.test` event to `url` with this API client's secret, so a
 * receiver can verify its signature check before relying on real events. Not queued
 * or retried; the result is returned directly.
 */
export async function POST(req: Request) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;

  const parsed = await parseV1Json(req, testWebhookSchema);
  if (parsed.response) return parsed.response;

  const allowed = await checkOutboundUrl(parsed.data.url);
  if (!allowed.ok) return v1Error(422, "callback_url_not_allowed", allowed.reason);

  const eventId = newId("evt");
  const body = JSON.stringify({
    id: eventId,
    type: "webhook.test",
    createdAt: new Date().toISOString(),
    message: "If your endpoint verified this signature, watch events will verify too.",
  });
  const result = await postSignedWebhook({
    url: parsed.data.url,
    secret: auth.client.webhookSecret,
    eventId,
    eventType: "webhook.test",
    body,
    attempt: 1,
  });
  return NextResponse.json({ eventId, delivered: result.ok, statusCode: result.statusCode, error: result.error });
}
