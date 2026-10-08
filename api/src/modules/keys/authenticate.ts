import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../../db/database";
import { accounts, apiKeys } from "../../db/schema";
import { API_KEY_PREFIX, apiKeyLookupPrefix, hashApiKey, type ApiKeyScope } from "./api-keys";

export type AuthenticatedKey = {
  keyId: string;
  accountId: string;
  scopes: ApiKeyScope[];
};

export type AuthenticateOutcome =
  | { kind: "authenticated"; key: AuthenticatedKey }
  | { kind: "invalid" }
  | { kind: "account_suspended" };

/** `last_used_at` is written at most this often per key, so reads stay reads. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Checked on every request, so a revoked key or a suspended account stops at once.
 * Looks the key up by its plaintext prefix and compares SHA-256 digests in constant time.
 */
export async function authenticateApiKey(
  db: Database,
  presented: string,
  now = new Date(),
): Promise<AuthenticateOutcome> {
  if (!presented.startsWith(API_KEY_PREFIX)) return { kind: "invalid" };
  const [row] = await db
    .select({ key: apiKeys, accountStatus: accounts.status })
    .from(apiKeys)
    .innerJoin(accounts, eq(accounts.id, apiKeys.accountId))
    .where(eq(apiKeys.prefix, apiKeyLookupPrefix(presented)));
  if (!row) return { kind: "invalid" };

  const matches = timingSafeEqual(
    Buffer.from(hashApiKey(presented), "hex"),
    Buffer.from(row.key.keyHash, "hex"),
  );
  if (
    !matches ||
    row.key.revokedAt !== null ||
    (row.key.expiresAt !== null && row.key.expiresAt <= now)
  ) {
    return { kind: "invalid" };
  }
  if (row.accountStatus !== "active") return { kind: "account_suspended" };

  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiKeys.id, row.key.id),
        or(
          isNull(apiKeys.lastUsedAt),
          lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
        ),
      ),
    );
  return {
    kind: "authenticated",
    key: {
      keyId: row.key.id,
      accountId: row.key.accountId,
      scopes: row.key.scopes as ApiKeyScope[],
    },
  };
}
