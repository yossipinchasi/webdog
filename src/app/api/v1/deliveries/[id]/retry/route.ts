import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { authenticateApiClient, v1Error, watchRevokedError } from "@/lib/v1/http";
import { toWebhookDeliveryJson } from "@/lib/v1/watch-format";
import { deliverDueWebhooks, requeueDelivery } from "@/lib/webhook-outbox";

/**
 * Re-send a failed delivery (e.g. after the receiver was down longer than the retry
 * window). Attempts once immediately; on failure it is back on the normal backoff.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;
  const { id } = await params;

  // Deliveries are visible to the account that owns the API client that signs them.
  const [row] = await db
    .select({ delivery: schema.webhookDelivery, clientRevokedAt: schema.apiClient.revokedAt })
    .from(schema.webhookDelivery)
    .innerJoin(schema.apiClient, eq(schema.apiClient.id, schema.webhookDelivery.apiClientId))
    .where(and(eq(schema.webhookDelivery.id, id), eq(schema.apiClient.ownerUserId, auth.client.ownerUserId)))
    .limit(1);
  if (!row) return v1Error(404, "not_found", "Delivery not found.");
  if (row.clientRevokedAt) return watchRevokedError();
  if (row.delivery.status !== "failed") {
    return v1Error(409, "delivery_not_failed", `Only failed deliveries can be retried (this one is ${row.delivery.status}).`);
  }

  // Re-checked atomically: a revocation that commits after the checks above still wins.
  if (!(await requeueDelivery(id))) {
    return v1Error(409, "delivery_not_failed", "This delivery can no longer be retried.");
  }
  await deliverDueWebhooks({ ids: [id] });
  const [updated] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, id)).limit(1);
  return NextResponse.json({ delivery: updated && toWebhookDeliveryJson(updated) });
}
