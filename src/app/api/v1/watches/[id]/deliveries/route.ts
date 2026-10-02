import { NextResponse } from "next/server";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { authenticateApiClient, v1Error } from "@/lib/v1/http";
import { decodeCursor, encodeCursor, listDeliveriesQuerySchema, toWebhookDeliveryJson } from "@/lib/v1/watch-format";
import { loadWatch } from "@/lib/v1/watches";

/** Webhook delivery history for a watch, newest first — status, attempts, and last error. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiClient(req, "read");
  if (!auth.client) return auth.response;
  const { id } = await params;

  const row = await loadWatch(auth.client.ownerUserId, id);
  if (!row) return v1Error(404, "not_found", "Watch not found.");

  const parsed = listDeliveriesQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return v1Error(422, "validation_failed", "Invalid query parameters.", parsed.error.flatten());
  }
  const q = parsed.data;

  const filters: SQL[] = [eq(schema.webhookDelivery.targetId, id)];
  if (q.status) filters.push(eq(schema.webhookDelivery.status, q.status));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) return v1Error(422, "invalid_cursor", "Unrecognized pagination cursor.");
    filters.push(
      or(
        lt(schema.webhookDelivery.createdAt, c.createdAt),
        and(eq(schema.webhookDelivery.createdAt, c.createdAt), lt(schema.webhookDelivery.id, c.id)),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(schema.webhookDelivery)
    .where(and(...filters))
    .orderBy(desc(schema.webhookDelivery.createdAt), desc(schema.webhookDelivery.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return NextResponse.json({
    deliveries: page.map(toWebhookDeliveryJson),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}
