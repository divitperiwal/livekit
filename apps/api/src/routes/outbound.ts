/**
 * Tools, campaigns and the do-not-call list: the dashboard routes for what an
 * agent can do on a call, and who it calls.
 *
 * Mounted beneath the session middleware in `api.ts`, so every handler here
 * runs with a session, and every query takes its organisation from that
 * session rather than from anything the request sent.
 */

import { Hono, type Context } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client";
import { campaignContacts, campaigns, suppressedNumbers, tools } from "../db/schema";
import { AuthError, requireWrite, type Session } from "../services/auth";
import {
  CampaignInputError,
  contactsFromCsv,
  contactsFromJson,
  normalizePhone,
  type RejectedRow,
} from "../services/campaign-rules";
import {
  addContacts,
  CampaignError,
  changeStatus,
  contactCounts,
  createCampaign,
  getCampaign,
  updateCampaign,
  type CampaignAction,
} from "../services/campaigns";
import { SecretsUnavailable } from "../services/secrets";
import { prepareTool, ToolInputError, toolView, type ToolInput } from "../services/tools";

type Vars = { session: Session; sessionId: string };
type Ctx = Context<{ Variables: Vars }>;

/** Turns the errors these routes expect into responses; rethrows the rest. */
function failure(c: Ctx, error: unknown) {
  if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
  if (error instanceof ToolInputError || error instanceof CampaignInputError) {
    return c.json({ error: error.message, fields: error.fieldErrors }, 422);
  }
  if (error instanceof CampaignError) return c.json({ error: error.message }, error.status);
  if (error instanceof SecretsUnavailable) return c.json({ error: error.message }, 503);
  throw error;
}

/** How many rejected rows an upload reports back in full. */
const REJECTED_SHOWN = 50;

export function outboundRoutes(db: Database) {
  const app = new Hono<{ Variables: Vars }>();

  // --- tools ---------------------------------------------------------------

  app.get("/tools", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db.select().from(tools).where(eq(tools.orgId, orgId)).orderBy(tools.name);
    return c.json({ tools: rows.map(toolView) });
  });

  app.post("/tools", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const values = await prepareTool((await c.req.json()) as ToolInput);
      const inserted = await db
        .insert(tools)
        .values({ ...values, orgId: session.orgId } as typeof tools.$inferInsert)
        .onConflictDoNothing({ target: [tools.orgId, tools.name] })
        .returning();
      if (!inserted[0]) return c.json({ error: "a tool with that name already exists" }, 409);
      return c.json({ tool: toolView(inserted[0]) }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * Edits a tool in place.
   *
   * Unlike an agent, a tool is not versioned: fixing a URL or rotating a key
   * should reach every agent using it without a republish. What *is* frozen
   * is which tools a published version has.
   */
  app.patch("/tools/:id", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const existing = (
        await db
          .select()
          .from(tools)
          .where(and(eq(tools.id, c.req.param("id")), eq(tools.orgId, session.orgId)))
          .limit(1)
      )[0];
      if (!existing) return c.json({ error: "no such tool" }, 404);

      const values = await prepareTool((await c.req.json()) as ToolInput, existing);
      const updated = await db
        .update(tools)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(tools.id, existing.id))
        .returning();
      return c.json({ tool: toolView(updated[0]!) });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return c.json({ error: "a tool with that name already exists" }, 409);
      }
      return failure(c, error);
    }
  });

  // --- campaigns -----------------------------------------------------------

  app.get("/campaigns", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.orgId, orgId))
      .orderBy(desc(campaigns.createdAt));
    const counts = await contactCounts(db, rows.map((r) => r.id));
    return c.json({ campaigns: rows.map((r) => ({ ...r, contacts: counts.get(r.id) ?? {} })) });
  });

  app.post("/campaigns", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const campaign = await createCampaign(db, session.orgId, await c.req.json());
      return c.json({ campaign }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/campaigns/:id", async (c) => {
    try {
      const { orgId } = c.get("session");
      const campaign = await getCampaign(db, orgId, c.req.param("id"));
      const status = c.req.query("status");
      const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

      const where = status
        ? and(eq(campaignContacts.campaignId, campaign.id), eq(campaignContacts.status, status as "pending"))
        : eq(campaignContacts.campaignId, campaign.id);
      const contacts = await db
        .select()
        .from(campaignContacts)
        .where(where)
        .orderBy(desc(campaignContacts.updatedAt))
        .limit(limit);

      const counts = await contactCounts(db, [campaign.id]);
      return c.json({ campaign, counts: counts.get(campaign.id) ?? {}, contacts });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.patch("/campaigns/:id", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const campaign = await updateCampaign(db, session.orgId, c.req.param("id"), await c.req.json());
      return c.json({ campaign });
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * Adds contacts, as CSV text or as JSON.
   *
   * `{ csv: "phone,name\n98...,Asha" }` or `{ contacts: [{ phone, variables }] }`.
   * Rows that are not phone numbers are reported back rather than failing the
   * upload: one bad cell in ten thousand rows should not cost the other 9,999.
   */
  app.post("/campaigns/:id/contacts", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const body = (await c.req.json()) as { csv?: unknown; contacts?: unknown };

      let parsed: { contacts: Parameters<typeof addContacts>[3]; rejected: RejectedRow[] };
      if (typeof body.csv === "string") parsed = contactsFromCsv(body.csv);
      else if (body.contacts !== undefined) parsed = contactsFromJson(body.contacts);
      else return c.json({ error: "send csv text or a contacts list" }, 400);

      const result = await addContacts(db, session.orgId, c.req.param("id"), parsed.contacts);
      return c.json({
        ...result,
        rejected: parsed.rejected.length,
        rejectedRows: parsed.rejected.slice(0, REJECTED_SHOWN),
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  for (const action of ["start", "pause", "resume", "cancel"] as CampaignAction[]) {
    app.post(`/campaigns/:id/${action}`, async (c) => {
      try {
        const session = c.get("session");
        requireWrite(session);
        const campaign = await changeStatus(db, session.orgId, c.req.param("id"), action);
        return c.json({ campaign });
      } catch (error) {
        return failure(c, error);
      }
    });
  }

  // --- the do-not-call list ------------------------------------------------

  app.get("/suppressions", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db
      .select()
      .from(suppressedNumbers)
      .where(eq(suppressedNumbers.orgId, orgId))
      .orderBy(desc(suppressedNumbers.createdAt))
      .limit(Math.min(Number(c.req.query("limit") ?? 200), 1000));
    return c.json({ suppressions: rows });
  });

  app.post("/suppressions", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const body = (await c.req.json()) as { numbers?: unknown; reason?: unknown };
      if (!Array.isArray(body.numbers) || body.numbers.length === 0) {
        return c.json({ error: "numbers must be a non-empty list" }, 400);
      }

      const valid: string[] = [];
      const invalid: string[] = [];
      for (const raw of body.numbers) {
        const e164 = typeof raw === "string" ? normalizePhone(raw) : null;
        if (e164) valid.push(e164);
        else invalid.push(String(raw));
      }
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

      const inserted = valid.length
        ? await db
            .insert(suppressedNumbers)
            .values(
              [...new Set(valid)].map((e164) => ({
                orgId: session.orgId,
                e164,
                source: "manual",
                reason,
                createdBy: session.userId,
              })),
            )
            .onConflictDoNothing({ target: [suppressedNumbers.orgId, suppressedNumbers.e164] })
            .returning({ id: suppressedNumbers.id })
        : [];

      // Contacts already waiting to be called are held back now rather than
      // at dial time, so a campaign's progress reflects it immediately.
      if (valid.length) {
        await db
          .update(campaignContacts)
          .set({ status: "suppressed", lastOutcome: "suppressed", updatedAt: new Date() })
          .where(
            and(
              eq(campaignContacts.orgId, session.orgId),
              eq(campaignContacts.status, "pending"),
              inArray(campaignContacts.e164, valid),
            ),
          );
      }

      return c.json({ added: inserted.length, invalid });
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * Takes a number off the list.
   *
   * Contacts already marked suppressed stay that way: someone who asked not
   * to be called and is then removed from the list by mistake should not be
   * called by a campaign that was running at the time.
   */
  app.delete("/suppressions/:id", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const deleted = await db
        .delete(suppressedNumbers)
        .where(and(eq(suppressedNumbers.id, c.req.param("id")), eq(suppressedNumbers.orgId, session.orgId)))
        .returning({ id: suppressedNumbers.id });
      if (!deleted[0]) return c.json({ error: "no such entry" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
