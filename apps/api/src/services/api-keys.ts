/**
 * API keys: how a customer's own systems call the public API.
 *
 * A key is shown once, when it is made, and only its SHA-256 is stored. A
 * fast hash is right here where it would be wrong for a password: the key is
 * 32 random bytes, so there is nothing to guess, and the hash is checked on
 * every request. The prefix is stored in the clear so a request can find its
 * one candidate row by prefix and the dashboard can show `am_live_3f9c…`.
 */

import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull, lt, or } from "drizzle-orm";

import type { Database } from "../db/client";
import { apiKeys } from "../db/schema";
import { secretsMatch } from "./auth";

export const SCOPES = ["calls:read", "calls:write", "campaigns:read", "campaigns:write"] as const;
export type Scope = (typeof SCOPES)[number];

export interface KeyPrincipal {
  keyId: string;
  orgId: string;
  scopes: string[];
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export async function createApiKey(
  db: Database,
  orgId: string,
  userId: string,
  name: string,
  scopes: string[] = [...SCOPES],
) {
  const unknown = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`unknown scopes: ${unknown.join(", ")}`);

  const prefix = randomBytes(6).toString("hex");
  const key = `am_live_${prefix}_${randomBytes(32).toString("base64url")}`;
  const row = (
    await db
      .insert(apiKeys)
      .values({ orgId, name, prefix, keyHash: hash(key), scopes: [...new Set(scopes)], createdBy: userId })
      .returning()
  )[0]!;
  return { key, row };
}

/** Who a presented key belongs to, or null if it is not a live key. */
export async function authenticateKey(db: Database, presented: string | undefined): Promise<KeyPrincipal | null> {
  const match = presented?.match(/^am_live_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/);
  if (!match) return null;

  const row = (await db.select().from(apiKeys).where(eq(apiKeys.prefix, match[1]!)).limit(1))[0];
  if (!row || !secretsMatch(hash(presented!), row.keyHash)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  // Recorded at most once a minute, so a busy integration is not a write per
  // request, and not awaited, so it never slows one down.
  const now = new Date();
  db.update(apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - 60_000))),
      ),
    )
    .catch(() => {});

  return { keyId: row.id, orgId: row.orgId, scopes: row.scopes };
}

/** A key as the dashboard lists it: never the key or its hash. */
export function keyView(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    display: `am_live_${row.prefix}_…`,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
