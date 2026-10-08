import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { onlyRow, type Database } from "../../db/database";
import { apiKeys, apiKeyScopes } from "../../db/schema";

export const API_KEY_PREFIX = "am_live_";
/** Plaintext characters kept after `am_live_`, for lookup and for telling keys apart. */
const LOOKUP_CHARACTERS = 8;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

/** `am_live_` + 32 random bytes (base64url). Shown once; only its SHA-256 is stored. */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, prefix: apiKeyLookupPrefix(key), keyHash: hashApiKey(key) };
}

export const apiKeyLookupPrefix = (key: string) =>
  key.slice(0, API_KEY_PREFIX.length + LOOKUP_CHARACTERS);

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

export async function issueApiKey(
  db: Database,
  input: {
    accountId: string;
    name: string;
    maxConcurrentCalls: number;
    scopes: readonly ApiKeyScope[];
    expiresAt: Date | null;
  },
) {
  const { key, prefix, keyHash } = generateApiKey();
  const row = await db
    .insert(apiKeys)
    .values({
      accountId: input.accountId,
      name: input.name,
      prefix,
      keyHash,
      scopes: [...input.scopes],
      maxConcurrentCalls: input.maxConcurrentCalls,
      expiresAt: input.expiresAt,
    })
    .returning()
    .then(onlyRow);
  return { key, apiKey: row };
}

/** Takes effect on the next request: the key is checked on every one. Returns false if no live key has that prefix. */
export async function revokeApiKey(
  db: Database,
  prefix: string,
  now = new Date(),
): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

export async function setApiKeyConcurrency(
  db: Database,
  prefix: string,
  maxConcurrentCalls: number,
): Promise<boolean> {
  const updated = await db
    .update(apiKeys)
    .set({ maxConcurrentCalls })
    .where(eq(apiKeys.prefix, prefix))
    .returning({ id: apiKeys.id });
  return updated.length > 0;
}

export function listApiKeys(db: Database, accountId: string) {
  return db
    .select({
      prefix: apiKeys.prefix,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      maxConcurrentCalls: apiKeys.maxConcurrentCalls,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, accountId))
    .orderBy(desc(apiKeys.createdAt));
}
