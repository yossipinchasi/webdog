import { NextResponse } from "next/server";
import { getWorkerHealth } from "@/lib/worker-health";

export const dynamic = "force-dynamic";

/**
 * Background worker health, from the heartbeats it writes to the database (see
 * `worker-health.ts`): 200 when both loops completed a pass recently, 503 otherwise.
 * Separate from `/api/health` on purpose: the web service's own healthcheck must not
 * fail (and get the web restarted) because the worker is down. Reports only loop
 * names, statuses and timestamps.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const health = await getWorkerHealth();
    return NextResponse.json(health, { status: health.status === "healthy" ? 200 : 503, headers });
  } catch {
    return NextResponse.json({ status: "unknown" }, { status: 503, headers });
  }
}
