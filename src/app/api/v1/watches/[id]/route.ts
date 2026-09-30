import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { monitorLimitError } from "@/lib/account-monitor-limits";
import { computeNextCheckDueAfterSuccess } from "@/lib/scraper";
import { authenticateApiClient, isUniqueViolation, parseV1Json, v1Error } from "@/lib/v1/http";
import { minutesToHours, updateWatchSchema } from "@/lib/v1/watch-format";
import { findOrCreateWebhookDestination, loadWatch, rowToWatchJson } from "@/lib/v1/watches";

type Params = { params: Promise<{ id: string }> };

const notFound = () => v1Error(404, "not_found", "Watch not found.");

export async function GET(req: Request, { params }: Params) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;
  const row = await loadWatch(auth.client.ownerUserId, (await params).id);
  if (!row) return notFound();
  return NextResponse.json({ watch: rowToWatchJson(row) });
}

export async function PATCH(req: Request, { params }: Params) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;
  const ownerId = auth.client.ownerUserId;
  const { id } = await params;

  const row = await loadWatch(ownerId, id);
  if (!row) return notFound();

  const parsed = await parseV1Json(req, updateWatchSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;
  const current = row.target;

  if (input.enabled === true && !current.enabled) {
    const limitError = await monitorLimitError(ownerId, { excludingTargetId: id });
    if (limitError) return v1Error(403, "monitor_limit_reached", limitError);
  }

  const updates: Partial<typeof schema.target.$inferInsert> = {};
  if (input.intent !== undefined) updates.watchNote = input.intent || null;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.intervalMinutes !== undefined) {
    const hours = minutesToHours(input.intervalMinutes);
    updates.checkIntervalHours = hours;
    // Same rescheduling rule as the dashboard: re-phase from the last check, or run next tick.
    updates.nextCheckDueAt =
      current.lastCheckedAt != null ? computeNextCheckDueAfterSuccess(current.lastCheckedAt, hours, Date.now()) : null;
  }
  if (input.callbackUrl !== undefined) {
    if (input.callbackUrl === null) {
      updates.externalNotify = false;
      updates.notificationDestinationId = null;
    } else {
      updates.externalNotify = true;
      updates.notificationDestinationId = await findOrCreateWebhookDestination(ownerId, input.callbackUrl);
    }
  }
  if (input.externalUserId !== undefined) updates.externalUserId = input.externalUserId;
  if (input.externalRef !== undefined) updates.externalRef = input.externalRef;
  if (input.metadata !== undefined) updates.metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  if (input.aiTriageEnabled !== undefined) updates.aiTriageEnabled = input.aiTriageEnabled;
  if (input.aiSummaryEnabled !== undefined) updates.aiChangeSummaryEnabled = input.aiSummaryEnabled;

  try {
    await db.update(schema.target).set(updates).where(eq(schema.target.id, id));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return v1Error(409, "external_ref_conflict", "Another watch from this API client already uses that externalRef.");
    }
    throw err;
  }

  const updated = await loadWatch(ownerId, id);
  return NextResponse.json({ watch: updated && rowToWatchJson(updated) });
}

export async function DELETE(req: Request, { params }: Params) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;
  const { id } = await params;
  const row = await loadWatch(auth.client.ownerUserId, id);
  if (!row) return notFound();
  await db.delete(schema.target).where(eq(schema.target.id, id));
  return new NextResponse(null, { status: 204 });
}
