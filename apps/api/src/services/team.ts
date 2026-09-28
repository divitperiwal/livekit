/**
 * Who belongs to an organisation, and bringing more people in.
 *
 * An invitation is a link with a random token, valid for a week; only the
 * token's hash is kept. Nothing is emailed from here -- the person inviting
 * copies the link -- because sending mail is a provider decision this
 * platform has not made yet, and a link that is shown once works today.
 *
 * Accepting an invite as a new address creates the account with the
 * password given. Accepting as an address that already has an account
 * requires that account's password, so an invite link alone can never be
 * used to take over an existing account.
 */

import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { invites, orgMembers, users } from "../db/schema";
import { AuthError, type Role } from "./auth";

const INVITE_DAYS = 7;
const ROLES: Role[] = ["owner", "admin", "developer", "viewer"];
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class TeamError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 410 | 422,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

export async function createInvite(db: Database, orgId: string, invitedBy: string, email: unknown, role: unknown) {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new TeamError("that is not an email address", 422);
  if (!isRole(role)) throw new TeamError(`role must be one of: ${ROLES.join(", ")}`, 422);

  const already = await db
    .select({ id: orgMembers.userId })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, orgId), eq(users.email, address)))
    .limit(1);
  if (already[0]) throw new TeamError("that person is already a member", 409);

  const token = randomBytes(32).toString("base64url");
  const row = (
    await db
      .insert(invites)
      .values({
        orgId,
        email: address,
        role,
        tokenHash: hash(token),
        invitedBy,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86400_000),
      })
      .returning()
  )[0]!;
  return { token, invite: row };
}

/**
 * Accepts an invite. Returns the email address, for signing in after.
 *
 * All in one transaction, and the invite is claimed conditionally, so a link
 * used twice at once adds the member once.
 */
export async function acceptInvite(db: Database, token: unknown, password: unknown, name: unknown) {
  if (typeof token !== "string" || typeof password !== "string") {
    throw new TeamError("token and password are required", 422);
  }
  return db.transaction(async (tx) => {
    const invite = (
      await tx
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invites.tokenHash, hash(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())))
        .returning()
    )[0];
    if (!invite) throw new TeamError("this invitation is not valid: it may have expired or been used", 410);

    let user = (await tx.select().from(users).where(eq(users.email, invite.email)).limit(1))[0];
    if (user) {
      const ok = await Bun.password.verify(password, user.passwordHash).catch(() => false);
      if (!ok) throw new AuthError("an account with this address exists; enter its password to join", 401);
    } else {
      if (password.length < 10) throw new TeamError("choose a password of at least 10 characters", 422);
      user = (
        await tx
          .insert(users)
          .values({
            email: invite.email,
            passwordHash: await Bun.password.hash(password, { algorithm: "argon2id" }),
            name: typeof name === "string" && name.trim() ? name.trim() : null,
            // Reaching the address the invite went to is the verification.
            emailVerifiedAt: new Date(),
          })
          .returning()
      )[0]!;
    }

    await tx
      .insert(orgMembers)
      .values({ orgId: invite.orgId, userId: user.id, role: invite.role })
      .onConflictDoNothing();
    return { email: user.email, orgId: invite.orgId };
  });
}

async function ownerCount(db: Pick<Database, "select">, orgId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")));
  return rows[0]?.n ?? 0;
}

/**
 * Changes a member's role, or removes them (`role` null).
 *
 * An organisation always keeps an owner: demoting or removing the last one
 * would leave nobody able to manage billing, keys or members.
 */
export async function changeMember(db: Database, orgId: string, userId: string, role: Role | null) {
  return db.transaction(async (tx) => {
    const member = (
      await tx
        .select()
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
        .limit(1)
    )[0];
    if (!member) throw new TeamError("no such member", 404);

    if (member.role === "owner" && role !== "owner" && (await ownerCount(tx, orgId)) <= 1) {
      throw new TeamError("an organisation must keep at least one owner", 409);
    }

    if (role === null) {
      await tx.delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    } else {
      await tx.update(orgMembers).set({ role }).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    }
  });
}
