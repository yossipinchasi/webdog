/**
 * Invite-only accounts (v1). There is no public sign-up: a new user can only be created
 *  - with an account invite (the sign-up form sends it in the `x-webdog-invite` header), or
 *  - by an operator with `npm run users -- create` (bootstrap the first owner).
 *
 * The check runs in Better Auth's `user.create.before` database hook, so it applies to every
 * path that creates a user, not just the sign-up endpoint. Creating a user consumes one use of
 * the invite atomically (`useCount < maxUses`, not expired), so one link can never create more
 * accounts than it has uses, even under concurrent sign-ups. The new user joins the inviting
 * account right away; the later `/invite/<token>` redeem step then finds the membership and
 * consumes nothing more.
 *
 * Existing users are unaffected: sign-in, sessions, and redeeming invites while signed in work
 * as before. The bootstrap allowance is process-local (AsyncLocalStorage around one call in the
 * CLI); the web server never enables it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db } from "./db";
import * as schema from "./db/schema";
import { INVITE_HEADER } from "./invite-header";
import { hashInviteToken } from "./invite-token";

const bootstrap = new AsyncLocalStorage<true>();

/** Run `fn` with uninvited user creation allowed (operator CLI only). */
export function withoutInvite<T>(fn: () => Promise<T>): Promise<T> {
  return bootstrap.run(true, fn);
}

type HookContext = { headers?: Headers | null; request?: Request | null } | null | undefined;

function inviteTokenFrom(ctx: HookContext): string | null {
  const headers = ctx?.headers ?? ctx?.request?.headers;
  const raw = headers?.get(INVITE_HEADER)?.trim();
  return raw ? raw : null;
}

export const INVITE_ONLY_MESSAGE = "Webdog is invite-only. Ask an account owner for an invite link.";
export const INVITE_INVALID_MESSAGE = "This invite link is not valid, has expired, or has no uses left.";

/** `user.create.before`: allow only with an invite, consuming one of its uses. */
export async function requireInviteForNewUser(ctx: HookContext): Promise<void> {
  if (bootstrap.getStore()) return;
  const token = inviteTokenFrom(ctx);
  if (!token) throw new APIError("FORBIDDEN", { message: INVITE_ONLY_MESSAGE });
  const [reserved] = await db
    .update(schema.accountInvite)
    .set({ useCount: sql`${schema.accountInvite.useCount} + 1` })
    .where(
      and(
        eq(schema.accountInvite.tokenHash, hashInviteToken(token)),
        gt(schema.accountInvite.expiresAt, sql`now()`),
        lt(schema.accountInvite.useCount, schema.accountInvite.maxUses),
      ),
    )
    .returning({ id: schema.accountInvite.id });
  if (!reserved) throw new APIError("FORBIDDEN", { message: INVITE_INVALID_MESSAGE });
}

/**
 * `user.create.after`: make the new user a member of the inviting account, with the same
 * side effects as redeeming an invite (skip the Context.dev onboarding meant for owners).
 */
export async function joinInvitingAccount(userId: string, ctx: HookContext): Promise<void> {
  if (bootstrap.getStore()) return;
  const token = inviteTokenFrom(ctx);
  if (!token) return;
  const [invite] = await db
    .select({ id: schema.accountInvite.id, ownerUserId: schema.accountInvite.ownerUserId })
    .from(schema.accountInvite)
    .where(eq(schema.accountInvite.tokenHash, hashInviteToken(token)))
    .limit(1);
  if (!invite || invite.ownerUserId === userId) return;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.accountMembership)
      .values({ ownerUserId: invite.ownerUserId, memberUserId: userId, createdAt: now })
      .onConflictDoNothing({ target: [schema.accountMembership.ownerUserId, schema.accountMembership.memberUserId] });
    await tx
      .update(schema.accountInvite)
      .set({ redeemedAt: now, redeemedByUserId: userId })
      .where(eq(schema.accountInvite.id, invite.id));
    await tx.update(schema.user).set({ contextIntroDismissedAt: now, updatedAt: now }).where(eq(schema.user.id, userId));
  });
}
