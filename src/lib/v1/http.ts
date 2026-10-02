/**
 * Request/response helpers for the `/api/v1` Watcher API. Errors use one machine-readable
 * shape — `{ "error": { "code", "message", "details"? } }` — so callers can branch on `code`.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import * as schema from "../db/schema";
import type { ApiClient } from "../db/schema";
import { hashApiKey, parseBearerApiKey } from "../api-keys";

/** Avoid a write per request: only refresh `lastUsedAt` when it is older than this. */
const LAST_USED_REFRESH_MS = 60_000;

export function v1Error(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

/** 409 for actions on a watch (or its deliveries) whose API client was revoked. History stays readable. */
export function watchRevokedError() {
  return v1Error(
    409,
    "watch_revoked",
    "The API key that created this watch was revoked, so the watch no longer runs. It can still be read or deleted.",
  );
}

export async function authenticateApiClient(
  req: Request,
): Promise<{ client: ApiClient; response: null } | { client: null; response: NextResponse }> {
  const key = parseBearerApiKey(req.headers.get("authorization"));
  if (!key) {
    return {
      client: null,
      response: v1Error(401, "unauthorized", "Missing or malformed API key. Send `Authorization: Bearer wk_…`."),
    };
  }
  const [client] = await db
    .select()
    .from(schema.apiClient)
    .where(and(eq(schema.apiClient.keyHash, hashApiKey(key)), isNull(schema.apiClient.revokedAt)))
    .limit(1);
  if (!client) {
    return { client: null, response: v1Error(401, "unauthorized", "Invalid or revoked API key.") };
  }
  const nowMs = Date.now();
  if (!client.lastUsedAt || nowMs - Number(client.lastUsedAt) > LAST_USED_REFRESH_MS) {
    await db.update(schema.apiClient).set({ lastUsedAt: new Date(nowMs) }).where(eq(schema.apiClient.id, client.id));
  }
  return { client, response: null };
}

export async function parseV1Json<T extends z.ZodTypeAny>(
  req: Request,
  bodySchema: T,
): Promise<{ data: z.infer<T>; response: null } | { data: null; response: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { data: null, response: v1Error(400, "invalid_json", "Request body must be valid JSON.") };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      data: null,
      response: v1Error(422, "validation_failed", "Request body failed validation.", parsed.error.flatten()),
    };
  }
  return { data: parsed.data, response: null };
}

/** Postgres unique_violation, surfaced through node-postgres / drizzle error wrapping. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++, e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
