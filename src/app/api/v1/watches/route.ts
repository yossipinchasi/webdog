import { NextResponse } from "next/server";
import { and, eq, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { normalizeDomain } from "@/lib/domain";
import { monitorLimitError } from "@/lib/account-monitor-limits";
import { runWebsiteChecks } from "@/lib/scraper";
import { authenticateApiClient, isUniqueViolation, parseV1Json, v1Error } from "@/lib/v1/http";
import {
  createWatchSchema,
  decodeCursor,
  encodeCursor,
  listWatchesQuerySchema,
  minutesToHours,
  TARGET_KIND_BY_WATCH_TYPE,
} from "@/lib/v1/watch-format";
import {
  baselineFailure,
  discardWatch,
  findOrCreateWebhookDestination,
  findOrCreateWebsite,
  findWatchByExternalRef,
  loadWatch,
  rowToWatchJson,
  selectWatches,
} from "@/lib/v1/watches";

/** List the account's watches, newest first, with keyset pagination. */
export async function GET(req: Request) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;

  const parsed = listWatchesQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return v1Error(422, "validation_failed", "Invalid query parameters.", parsed.error.flatten());
  }
  const q = parsed.data;

  const filters: SQL[] = [];
  if (q.externalUserId) filters.push(eq(schema.target.externalUserId, q.externalUserId));
  if (q.externalRef) filters.push(eq(schema.target.externalRef, q.externalRef));
  if (q.type) filters.push(eq(schema.target.kind, TARGET_KIND_BY_WATCH_TYPE[q.type]));
  if (q.enabled) filters.push(eq(schema.target.enabled, q.enabled === "true"));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) return v1Error(422, "invalid_cursor", "Unrecognized pagination cursor.");
    filters.push(
      or(
        lt(schema.target.createdAt, c.createdAt),
        and(eq(schema.target.createdAt, c.createdAt), lt(schema.target.id, c.id)),
      )!,
    );
  }

  const rows = await selectWatches(auth.client.ownerUserId, and(...filters), q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return NextResponse.json({
    watches: page.map(rowToWatchJson),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.target.createdAt, last.target.id) : null,
  });
}

/**
 * Create a watch. The website is found or created from the URL's domain, `callbackUrl`
 * becomes the watch's webhook destination, and (unless `baseline: false`) the first
 * check runs before responding so an unreachable page or a non-product page is
 * rejected here rather than failing silently later.
 */
export async function POST(req: Request) {
  const auth = await authenticateApiClient(req);
  if (!auth.client) return auth.response;
  const client = auth.client;
  const ownerId = client.ownerUserId;

  const parsed = await parseV1Json(req, createWatchSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const replay = async () => {
    const existing = input.externalRef ? await findWatchByExternalRef(ownerId, client.id, input.externalRef) : null;
    return existing
      ? NextResponse.json({ watch: rowToWatchJson(existing), baseline: { status: "not_requested" }, replayed: true })
      : null;
  };
  const replayed = await replay();
  if (replayed) return replayed;

  const domain = normalizeDomain(input.url);
  if (!domain) return v1Error(422, "invalid_url", "The URL must have a valid public hostname.");

  const limitError = await monitorLimitError(ownerId);
  if (limitError) return v1Error(403, "monitor_limit_reached", limitError);

  const website = await findOrCreateWebsite(ownerId, domain);
  const destinationId = input.callbackUrl ? await findOrCreateWebhookDestination(ownerId, input.callbackUrl) : null;
  const kind = TARGET_KIND_BY_WATCH_TYPE[input.type];
  const targetId = newId("tgt");

  try {
    await db.insert(schema.target).values({
      id: targetId,
      websiteId: website.id,
      kind,
      linkScope: kind === "SITEMAP_LINKS" ? "BOTH" : null,
      pageUrl: kind === "SITEMAP_LINKS" ? null : input.url,
      watchNote: input.intent || null,
      enabled: true,
      checkIntervalHours: minutesToHours(input.intervalMinutes),
      externalNotify: destinationId !== null,
      notificationDestinationId: destinationId,
      aiChangeSummaryEnabled: input.aiSummaryEnabled,
      aiTriageEnabled: input.aiTriageEnabled,
      apiClientId: client.id,
      externalUserId: input.externalUserId ?? null,
      externalRef: input.externalRef ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: new Date(),
    });
  } catch (err) {
    // A concurrent create with the same externalRef won the unique index: return that watch.
    if (isUniqueViolation(err)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw err;
  }

  let baseline: "completed" | "pending" | "not_requested" = "not_requested";
  if (input.baseline) {
    const result = await runWebsiteChecks(website.id, { targetId });
    if (result.skipped) {
      // Another check of this website is running; the worker takes the baseline on its next tick.
      baseline = "pending";
    } else {
      const failure = await baselineFailure(targetId, kind);
      if (failure) {
        await discardWatch(targetId, website);
        return v1Error(422, failure.code, failure.message);
      }
      baseline = "completed";
    }
  }

  const row = await loadWatch(ownerId, targetId);
  return NextResponse.json({ watch: row && rowToWatchJson(row), baseline: { status: baseline } }, { status: 201 });
}
