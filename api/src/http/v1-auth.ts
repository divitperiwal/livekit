import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "../db/database";
import { orgs } from "../db/schema";
import type { ApiKeyScope } from "../modules/keys/api-keys";
import { authenticateApiKey, type AuthenticatedKey } from "../modules/keys/authenticate";
import { HttpError } from "./errors";
import type { FixedWindowRateLimiter } from "./rate-limit";

export type OrgRow = typeof orgs.$inferSelect;
export type V1Env = { Variables: { apiKey: AuthenticatedKey; org: OrgRow } };

/** Bearer key on every /v1 request, then the per-key rate limit. */
export function requireApiKey(
  db: Database,
  limiter: FixedWindowRateLimiter,
): MiddlewareHandler<V1Env> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const outcome = await authenticateApiKey(db, presented);
    if (outcome.kind === "invalid") throw new HttpError(401, "missing, revoked or unknown API key");
    if (outcome.kind === "account_suspended") throw new HttpError(403, "account suspended");
    const retryAfter = limiter.take(outcome.key.keyId);
    if (retryAfter !== null) {
      c.header("retry-after", String(retryAfter));
      throw new HttpError(429, "rate limit exceeded");
    }
    c.set("apiKey", outcome.key);
    await next();
  };
}

export function requireScope(scope: ApiKeyScope): MiddlewareHandler<V1Env> {
  return async (c, next) => {
    if (!c.get("apiKey").scopes.includes(scope)) {
      throw new HttpError(403, `this key lacks the ${scope} scope`);
    }
    await next();
  };
}

/** The account's own org by its external id; anything else (another account's, deleted) is 404. */
export function requireOrg(db: Database): MiddlewareHandler<V1Env> {
  return async (c, next) => {
    const externalId = c.req.param("externalId");
    if (!externalId) throw new HttpError(404, "org not found");
    const [org] = await db
      .select()
      .from(orgs)
      .where(
        and(
          eq(orgs.accountId, c.get("apiKey").accountId),
          eq(orgs.externalId, externalId),
          isNull(orgs.deletedAt),
        ),
      );
    if (!org) throw new HttpError(404, "org not found");
    c.set("org", org);
    await next();
  };
}

export const currentOrg = (c: Context<V1Env>) => c.get("org");
