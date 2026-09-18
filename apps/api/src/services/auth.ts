/**
 * Who is asking, and what they are allowed to see.
 *
 * Sessions live in Redis rather than in a signed cookie, so signing out and
 * revoking an account take effect immediately instead of whenever a token
 * happens to expire. The cookie carries an opaque id and nothing else.
 *
 * Every session names one organisation. A user who belongs to several picks
 * one, and the whole request is scoped to it -- which is what makes the
 * scoping a property of the session rather than something each query has to
 * remember on its own.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { redis } from "../cache";
import type { Database } from "../db/client";
import { orgMembers, orgs, users } from "../db/schema";

/**
 * How long a session lasts without use.
 *
 * Refreshed on every request, so an active session does not expire under
 * someone mid-task; an abandoned one goes within a day.
 */
const SESSION_TTL_SECONDS = 60 * 60 * 24;

export type Role = "owner" | "admin" | "developer" | "viewer";

export interface Session {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 409,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function sessionKey(id: string): string {
  return `session:${id}`;
}

/**
 * Signs in, or refuses without saying which half was wrong.
 *
 * "No account with that address" and "wrong password" are the same message on
 * purpose: telling them apart turns the login form into a way to discover who
 * has an account here.
 *
 * A hash is verified even when no user was found, so the two paths take
 * roughly the same time and the response cannot be timed to the same effect.
 */
export async function signIn(
  db: Database,
  email: string,
  password: string,
): Promise<{ sessionId: string; session: Session }> {
  const found = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const user = found[0];
  const hash =
    user?.passwordHash ??
    // A real argon2id hash of a value nobody can present, so the comparison
    // below does the same work whether or not the account exists.
    "$argon2id$v=19$m=65536,t=2,p=1$YXV0b21pdHJhLXBsYWNlaG9sZGVy$3l5bVtTwqNRrNxqHqPQqGRwHHBzMqvBTPAVsQ0LMQ0k";

  const ok = await Bun.password.verify(password, hash).catch(() => false);
  if (!user || !ok) {
    throw new AuthError("that email and password do not match", 401);
  }

  const memberships = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role, slug: orgs.slug })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, user.id));

  const membership = memberships[0];
  if (!membership) {
    throw new AuthError("this account does not belong to an organisation", 403);
  }

  const session: Session = {
    userId: user.id,
    orgId: membership.orgId,
    role: membership.role,
    email: user.email,
  };

  const sessionId = randomBytes(32).toString("base64url");
  await redis().set(
    sessionKey(sessionId),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS,
  );

  return { sessionId, session };
}

/** Reads a session and extends it. Returns null when there is none. */
export async function readSession(sessionId: string): Promise<Session | null> {
  try {
    const raw = await redis().get(sessionKey(sessionId));
    if (!raw) return null;
    // Sliding expiry: an active session should not end under someone who is
    // still using it.
    await redis().expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
    return JSON.parse(raw) as Session;
  } catch {
    // A cache that is down means nobody is signed in, which is the safe
    // reading -- better than treating an unreadable session as valid.
    return null;
  }
}

export async function signOut(sessionId: string): Promise<void> {
  try {
    await redis().del(sessionKey(sessionId));
  } catch {
    /* the session expires on its own soon enough */
  }
}

/** Switches the organisation a session is scoped to. */
export async function switchOrg(
  db: Database,
  sessionId: string,
  session: Session,
  orgId: string,
): Promise<Session> {
  const rows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, session.userId), eq(orgMembers.orgId, orgId)))
    .limit(1);

  const membership = rows[0];
  if (!membership) {
    throw new AuthError("you do not belong to that organisation", 403);
  }

  const next: Session = { ...session, orgId, role: membership.role };
  await redis().set(
    sessionKey(sessionId),
    JSON.stringify(next),
    "EX",
    SESSION_TTL_SECONDS,
  );
  return next;
}

/** Every organisation a user can act in, for the switcher. */
export async function organisationsFor(db: Database, userId: string) {
  return db
    .select({
      id: orgs.id,
      name: orgs.name,
      slug: orgs.slug,
      role: orgMembers.role,
    })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId));
}

/**
 * What each role may do.
 *
 * Deliberately coarse. Four roles cover everyone until an enterprise deal asks
 * for something finer, and a permission model invented before anyone has asked
 * for it tends to be wrong in ways that are expensive to unpick.
 */
const WRITE_ROLES: readonly Role[] = ["owner", "admin", "developer"];
const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];

export function canWrite(role: Role): boolean {
  return WRITE_ROLES.includes(role);
}

export function canAdminister(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

export function requireWrite(session: Session): void {
  if (!canWrite(session.role)) {
    throw new AuthError("your role is read-only", 403);
  }
}

export function requireAdmin(session: Session): void {
  if (!canAdminister(session.role)) {
    throw new AuthError("only an owner or admin may do that", 403);
  }
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Exported here so the API-key path and the internal-secret check use the same
 * comparison rather than each growing its own.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
