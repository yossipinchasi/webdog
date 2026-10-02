#!/usr/bin/env tsx
// Create a user without an invite (accounts are invite-only; see src/lib/invite-signup.ts).
// Use it to create the first account owner; everyone else joins through account invites.
//   npm run users -- create --email owner@example.com --name "Owner"           prints a generated password once
//   npm run users -- create --email owner@example.com --name "Owner" --password-stdin   reads it from stdin
// Env: DATABASE_URL, BETTER_AUTH_SECRET (required in production), DATA_ENCRYPTION_KEY.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { auth } from "../src/lib/auth";
import { withoutInvite } from "../src/lib/invite-signup";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function create(args: string[]) {
  const email = flag(args, "email")?.trim();
  const name = flag(args, "name")?.trim();
  if (!email || !name) throw new Error('Usage: create --email <email> --name "<name>" [--password-stdin]');
  const fromStdin = args.includes("--password-stdin");
  const password = fromStdin ? await readStdin() : randomBytes(18).toString("base64url");
  if (password.length < 8) throw new Error("The password must be at least 8 characters.");

  const res = await withoutInvite(() => auth.api.signUpEmail({ body: { email, name, password } }));
  console.log(`Created user ${res.user.id} (${res.user.email}).`);
  if (!fromStdin) console.log(`\nPassword (shown once; sign in and keep it safe):\n\n  ${password}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") await create(args);
  else throw new Error("Commands: create");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[users] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
