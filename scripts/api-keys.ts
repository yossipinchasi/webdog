#!/usr/bin/env tsx
// Manage Watcher API (/api/v1) keys. A key acts as the account it is created for.
//   npm run api-keys -- create --email owner@example.com --name "My platform"
//   npm run api-keys -- list [--email owner@example.com]
//   npm run api-keys -- revoke <apiClientId>
// Env: DATABASE_URL.

import "dotenv/config";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import * as schema from "../src/lib/db/schema";
import { newId } from "../src/lib/ids";
import { generateApiKey } from "../src/lib/api-keys";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function userIdByEmail(email: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email.trim().toLowerCase()))
    .limit(1);
  if (!u) throw new Error(`No account with email ${email}. Sign up in the dashboard first.`);
  return u.id;
}

async function create(args: string[]) {
  const email = flag(args, "email");
  const name = flag(args, "name")?.trim();
  if (!email || !name) throw new Error('Usage: create --email <owner email> --name "<label>"');
  const ownerUserId = await userIdByEmail(email);
  const { key, keyHash, keyPrefix } = generateApiKey();
  const id = newId("akey");
  await db.insert(schema.apiClient).values({ id, ownerUserId, name, keyPrefix, keyHash, createdAt: new Date() });
  console.log(`Created API client ${id} ("${name}") for ${email}.`);
  console.log("\nAPI key (shown once — store it now; only its hash is kept):\n");
  console.log(`  ${key}\n`);
}

async function list(args: string[]) {
  const email = flag(args, "email");
  const rows = await db
    .select({ client: schema.apiClient, email: schema.user.email })
    .from(schema.apiClient)
    .innerJoin(schema.user, eq(schema.user.id, schema.apiClient.ownerUserId))
    .where(email ? eq(schema.user.email, email.trim().toLowerCase()) : undefined)
    .orderBy(desc(schema.apiClient.createdAt));
  if (rows.length === 0) return console.log("No API clients.");
  for (const { client: c, email: owner } of rows) {
    const state = c.revokedAt ? `revoked ${c.revokedAt.toISOString()}` : "active";
    const used = c.lastUsedAt ? c.lastUsedAt.toISOString() : "never";
    console.log(`${c.id}  ${c.keyPrefix}…  "${c.name}"  owner=${owner}  ${state}  lastUsed=${used}`);
  }
}

async function revoke(args: string[]) {
  const id = args[0];
  if (!id) throw new Error("Usage: revoke <apiClientId>");
  const res = await db
    .update(schema.apiClient)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiClient.id, id), isNull(schema.apiClient.revokedAt)))
    .returning({ id: schema.apiClient.id });
  console.log(res.length ? `Revoked ${id}.` : `No active API client ${id}.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") await create(args);
  else if (command === "list") await list(args);
  else if (command === "revoke") await revoke(args);
  else throw new Error("Commands: create | list | revoke");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
