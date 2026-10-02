import { NextResponse } from "next/server";
import { runWebsiteChecks } from "@/lib/scraper";
import { authenticateApiClient, v1Error, watchRevokedError } from "@/lib/v1/http";
import { loadWatch, rowToWatchJson } from "@/lib/v1/watches";

/** Check a watch now (ignores its schedule and paused state), like the dashboard's "Check now". */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiClient(req, "check");
  if (!auth.client) return auth.response;
  const ownerId = auth.client.ownerUserId;
  const { id } = await params;

  const row = await loadWatch(ownerId, id);
  if (!row) return v1Error(404, "not_found", "Watch not found.");
  if (row.clientRevokedAt) return watchRevokedError();

  const result = await runWebsiteChecks(row.website.id, { targetId: id });
  if (result.skipped) {
    return v1Error(409, "check_in_progress", "A check is already running for this website. Try again in a moment.");
  }

  const updated = await loadWatch(ownerId, id);
  return NextResponse.json({
    result: { events: result.alerts, errors: result.errors },
    watch: updated && rowToWatchJson(updated),
  });
}
