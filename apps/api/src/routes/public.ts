/**
 * The public API, `/v1`: what a customer's own systems call.
 *
 * Authenticated by API key (`Authorization: Bearer am_live_…`), scoped to the
 * key's organisation exactly as the dashboard's routes are scoped to the
 * session's. Each route also names the scope it needs, so a key made only to
 * read call results cannot start calls.
 *
 * Calls come back in the same shape the `call.ended` webhook sends, so an
 * integration can take either and treat them alike.
 */

import { Hono, type Context } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";

import { redis } from "../cache";
import type { Database } from "../db/client";
import { calls, campaignContacts } from "../db/schema";
import { authenticateKey, type KeyPrincipal, type Scope } from "../services/api-keys";
import { callView, callWithTranscript } from "../services/call-view";
import { CampaignInputError, contactsFromJson } from "../services/campaign-rules";
import { addContacts, CampaignError, changeStatus, contactCounts, getCampaign } from "../services/campaigns";
import type { Dispatcher } from "../services/dialer";
import { CallRequestError, placeCall } from "../services/outbound-call";

type Vars = { key: KeyPrincipal };
type Ctx = Context<{ Variables: Vars }>;

const RATE_PER_MINUTE = Number(process.env.PUBLIC_API_RATE_PER_MIN ?? 300);

/**
 * Requests per key per minute. Fails open: a cache outage must not take a
 * customer's integration down with it, and the limit is a guard against
 * runaway loops, not a security boundary.
 */
async function withinRate(keyId: string): Promise<boolean> {
  try {
    const bucket = `rl:${keyId}:${Math.floor(Date.now() / 60_000)}`;
    const count = await redis().incr(bucket);
    if (count === 1) await redis().expire(bucket, 90);
    return count <= RATE_PER_MINUTE;
  } catch {
    return true;
  }
}

function failure(c: Ctx, error: unknown) {
  if (error instanceof CallRequestError || error instanceof CampaignError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof CampaignInputError) return c.json({ error: error.message, fields: error.fieldErrors }, 422);
  throw error;
}

export function publicRoutes(db: Database, dispatcher: () => Dispatcher) {
  const app = new Hono<{ Variables: Vars }>();

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = await authenticateKey(db, header.replace(/^Bearer\s+/i, "").trim());
    if (!key) return c.json({ error: "a valid API key is required: Authorization: Bearer am_live_…" }, 401);
    if (!(await withinRate(key.keyId))) {
      c.header("Retry-After", "60");
      return c.json({ error: `rate limit of ${RATE_PER_MINUTE} requests a minute exceeded` }, 429);
    }
    c.set("key", key);
    await next();
  });

  function allowed(c: Ctx, scope: Scope) {
    return c.get("key").scopes.includes(scope);
  }
  const forbidden = (c: Ctx, scope: Scope) => c.json({ error: `this key does not have the ${scope} scope` }, 403);

  // --- calls ---------------------------------------------------------------

  /**
   * Places one outbound call. Returns as soon as the agent is dispatched,
   * with a `requestId`: the call record does not exist until the phone is
   * answered or the attempt fails, and the `call.ended` webhook -- or
   * `GET /v1/calls?requestId=` -- carries the same id when it does.
   */
  app.post("/calls", async (c) => {
    if (!allowed(c, "calls:write")) return forbidden(c, "calls:write");
    try {
      // Resolved only at the moment of dispatch, so a request is validated
      // in full -- and refused with a reason -- before a missing LiveKit
      // configuration can turn it into a 503.
      const lazy: Dispatcher = { dispatch: (room, metadata) => dispatcher().dispatch(room, metadata) };
      const result = await placeCall(db, lazy, c.get("key").orgId, await c.req.json());
      return c.json(result, 202);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/calls", async (c) => {
    if (!allowed(c, "calls:read")) return forbidden(c, "calls:read");
    const { orgId } = c.get("key");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const filters = [eq(calls.orgId, orgId)];
    const requestId = c.req.query("requestId");
    if (requestId) filters.push(sql`${calls.metadata}->>'requestId' = ${requestId}`);
    const disposition = c.req.query("disposition");
    if (disposition) filters.push(eq(calls.disposition, disposition));
    const campaignId = c.req.query("campaignId");
    if (campaignId) filters.push(sql`${calls.metadata}->>'campaignId' = ${campaignId}`);
    const before = c.req.query("before");
    if (before && !Number.isNaN(Date.parse(before))) filters.push(sql`${calls.createdAt} < ${before}::timestamptz`);

    const rows = await db
      .select()
      .from(calls)
      .where(and(...filters))
      .orderBy(desc(calls.createdAt))
      .limit(limit);
    return c.json({ calls: rows.map((r) => callView(r)) });
  });

  app.get("/calls/:id", async (c) => {
    if (!allowed(c, "calls:read")) return forbidden(c, "calls:read");
    const id = c.req.param("id");
    // Checked against the key's organisation before anything is read, so an
    // id alone never reaches another tenant's call.
    const owned = await db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.id, id), eq(calls.orgId, c.get("key").orgId)))
      .limit(1);
    if (!owned[0]) return c.json({ error: "no such call" }, 404);
    return c.json({ call: await callWithTranscript(db, id) });
  });

  // --- campaigns -----------------------------------------------------------

  app.get("/campaigns/:id", async (c) => {
    if (!allowed(c, "campaigns:read")) return forbidden(c, "campaigns:read");
    try {
      const campaign = await getCampaign(db, c.get("key").orgId, c.req.param("id"));
      const counts = await contactCounts(db, [campaign.id]);
      return c.json({
        campaign: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          statusReason: campaign.statusReason,
          contacts: counts.get(campaign.id) ?? {},
        },
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  /** Adds contacts: `{ contacts: [{ phone, variables }] }`. Duplicates are skipped. */
  app.post("/campaigns/:id/contacts", async (c) => {
    if (!allowed(c, "campaigns:write")) return forbidden(c, "campaigns:write");
    try {
      const body = (await c.req.json()) as { contacts?: unknown };
      const parsed = contactsFromJson(body.contacts);
      const result = await addContacts(db, c.get("key").orgId, c.req.param("id"), parsed.contacts);
      return c.json({ ...result, rejected: parsed.rejected.length, rejectedRows: parsed.rejected.slice(0, 50) });
    } catch (error) {
      return failure(c, error);
    }
  });

  for (const action of ["start", "pause", "resume", "cancel"] as const) {
    app.post(`/campaigns/:id/${action}`, async (c) => {
      if (!allowed(c, "campaigns:write")) return forbidden(c, "campaigns:write");
      try {
        const campaign = await changeStatus(db, c.get("key").orgId, c.req.param("id"), action);
        return c.json({ campaign: { id: campaign.id, status: campaign.status } });
      } catch (error) {
        return failure(c, error);
      }
    });
  }

  /** A campaign's contacts and how each is going. */
  app.get("/campaigns/:id/contacts", async (c) => {
    if (!allowed(c, "campaigns:read")) return forbidden(c, "campaigns:read");
    try {
      const campaign = await getCampaign(db, c.get("key").orgId, c.req.param("id"));
      const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000);
      const rows = await db
        .select({
          id: campaignContacts.id,
          phone: campaignContacts.e164,
          status: campaignContacts.status,
          attempts: campaignContacts.attempts,
          lastOutcome: campaignContacts.lastOutcome,
          lastCallId: campaignContacts.lastCallId,
          nextAttemptAt: campaignContacts.nextAttemptAt,
          variables: campaignContacts.variables,
        })
        .from(campaignContacts)
        .where(eq(campaignContacts.campaignId, campaign.id))
        .orderBy(campaignContacts.createdAt)
        .limit(limit);
      return c.json({ contacts: rows });
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
