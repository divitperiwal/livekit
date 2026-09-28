/**
 * Measuring and improving agents, and running the organisation: analytics,
 * creating agents, A/B experiments, test suites, the team, and erasure.
 *
 * Mounted beneath the session middleware in `api.ts`, scoped by the
 * session's organisation like everything else there.
 */

import { Hono, type Context } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";

import { invalidateAgent } from "../cache";
import type { Database } from "../db/client";
import { DEFAULT_AGENT_CONFIG } from "../db/agent-config";
import {
  agents,
  agentVersions,
  evalResults,
  evalRuns,
  evalScenarios,
  invites,
  orgMembers,
  users,
} from "../db/schema";
import { validateAgentConfig } from "../db/validate-config";
import { analytics } from "../services/analytics";
import { AuthError, requireAdmin, requireWrite, type Session } from "../services/auth";
import { normalizePhone } from "../services/campaign-rules";
import { liveKitDispatcher, type Dispatcher } from "../services/dialer";
import { erasePhoneNumber } from "../services/privacy";
import { recordingStore } from "../services/recordings";
import { changeMember, createInvite, isRole, TeamError } from "../services/team";

type Vars = { session: Session; sessionId: string };
type Ctx = Context<{ Variables: Vars }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InputError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422 | 503 = 422) {
    super(message);
  }
}

function failure(c: Ctx, error: unknown) {
  if (error instanceof AuthError || error instanceof TeamError || error instanceof InputError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

const STARTER_PROMPT = `You answer phone calls for this business.

Greet the caller, find out what they need, and help them with it. If you do
not know something, say so and offer to have someone call them back.`;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

/** A scenario from a request body, checked. */
function scenarioValues(body: Record<string, unknown>) {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = text(body.name, 100);
  const caller = text(body.caller, 2000);
  if (!name) throw new InputError("name is required");
  if (!caller) throw new InputError("describe the caller: who they are and what they want");
  const criteria = Array.isArray(body.criteria)
    ? body.criteria.map((c) => text(c, 300)).filter(Boolean).slice(0, 10)
    : [];
  if (criteria.length === 0) throw new InputError("add at least one thing the agent must do");
  const maxTurns = body.maxTurns === undefined ? 8 : Number(body.maxTurns);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) throw new InputError("maxTurns must be 1 to 20");
  const stringMap = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]))
      : {};
  return { name, caller, criteria, maxTurns, variables: stringMap(body.variables), toolResponses: stringMap(body.toolResponses) };
}

export function insightsRoutes(db: Database, dispatcher: () => Dispatcher = liveKitDispatcher) {
  const app = new Hono<{ Variables: Vars }>();

  async function ownAgent(orgId: string, id: string) {
    if (!UUID.test(id)) throw new InputError("no such agent", 404);
    const agent = (
      await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.orgId, orgId))).limit(1)
    )[0];
    if (!agent) throw new InputError("no such agent", 404);
    return agent;
  }

  // --- analytics ---------------------------------------------------------------

  app.get("/analytics", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
    const agentId = c.req.query("agentId");
    const campaignId = c.req.query("campaignId");
    return c.json(
      await analytics(db, {
        orgId: c.get("session").orgId,
        days,
        agentId: agentId && UUID.test(agentId) ? agentId : undefined,
        campaignId: campaignId && UUID.test(campaignId) ? campaignId : undefined,
      }),
    );
  });

  // --- agents --------------------------------------------------------------------

  /**
   * Creates an agent with a first, published version: a starter prompt and
   * the default configuration. Publishing it at once means a new agent can be
   * test-called immediately, which is the first thing anyone does with one.
   */
  app.post("/agents", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const body = (await c.req.json()) as { name?: unknown; description?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new InputError("name is required");

      const base = slugify(name);
      const taken = new Set(
        (
          await db
            .select({ slug: agents.slug })
            .from(agents)
            .where(and(eq(agents.orgId, session.orgId), sql`${agents.slug} like ${`${base}%`}`))
        ).map((r) => r.slug),
      );
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

      const agent = await db.transaction(async (tx) => {
        const row = (
          await tx
            .insert(agents)
            .values({
              orgId: session.orgId,
              name,
              slug,
              description: typeof body.description === "string" ? body.description.trim() || null : null,
            })
            .returning()
        )[0]!;
        const version = (
          await tx
            .insert(agentVersions)
            .values({
              agentId: row.id,
              orgId: session.orgId,
              version: 1,
              instructions: STARTER_PROMPT,
              greeting: "Greet the caller warmly and ask how you can help.",
              config: validateAgentConfig(DEFAULT_AGENT_CONFIG),
              publishedAt: new Date(),
              publishedBy: session.userId,
            })
            .returning()
        )[0]!;
        await tx.update(agents).set({ liveVersionId: version.id, draftVersionId: version.id }).where(eq(agents.id, row.id));
        return row;
      });
      return c.json({ agent }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * Starts, changes or stops an A/B experiment: `{ versionId, percent }`, or
   * `{ versionId: null }` to stop. The candidate must be another version of
   * the same agent; the live version takes the rest of the calls.
   */
  app.put("/agents/:id/experiment", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const agent = await ownAgent(session.orgId, c.req.param("id"));
      const body = (await c.req.json()) as { versionId?: unknown; percent?: unknown };

      if (body.versionId === null || body.versionId === undefined) {
        await db.update(agents).set({ candidateVersionId: null, candidatePercent: 0 }).where(eq(agents.id, agent.id));
      } else {
        const percent = Number(body.percent);
        if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
          throw new InputError("percent must be a whole number from 1 to 99");
        }
        if (typeof body.versionId !== "string" || !UUID.test(body.versionId)) throw new InputError("no such version", 404);
        const version = (
          await db
            .select({ id: agentVersions.id })
            .from(agentVersions)
            .where(and(eq(agentVersions.id, body.versionId), eq(agentVersions.agentId, agent.id)))
            .limit(1)
        )[0];
        if (!version) throw new InputError("that is not a version of this agent", 404);
        if (version.id === agent.liveVersionId) throw new InputError("the candidate must differ from the live version", 409);
        await db
          .update(agents)
          .set({ candidateVersionId: version.id, candidatePercent: percent })
          .where(eq(agents.id, agent.id));
      }
      // Takes effect on the next call rather than within the routing's TTL.
      await invalidateAgent(agent.id);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  // --- test suites ---------------------------------------------------------------

  app.get("/agents/:id/scenarios", async (c) => {
    try {
      const agent = await ownAgent(c.get("session").orgId, c.req.param("id"));
      const rows = await db
        .select()
        .from(evalScenarios)
        .where(eq(evalScenarios.agentId, agent.id))
        .orderBy(evalScenarios.createdAt);
      return c.json({ scenarios: rows });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/agents/:id/scenarios", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const agent = await ownAgent(session.orgId, c.req.param("id"));
      const values = scenarioValues(await c.req.json());
      const row = (
        await db.insert(evalScenarios).values({ ...values, orgId: session.orgId, agentId: agent.id }).returning()
      )[0]!;
      return c.json({ scenario: row }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.delete("/scenarios/:id", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      if (!UUID.test(c.req.param("id"))) throw new InputError("no such scenario", 404);
      const deleted = await db
        .delete(evalScenarios)
        .where(and(eq(evalScenarios.id, c.req.param("id")), eq(evalScenarios.orgId, session.orgId)))
        .returning({ id: evalScenarios.id });
      if (!deleted[0]) throw new InputError("no such scenario", 404);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * Runs every scenario against a version -- the live one unless another is
   * named -- by dispatching a test job to the worker fleet.
   */
  app.post("/agents/:id/eval-runs", async (c) => {
    try {
      const session = c.get("session");
      requireWrite(session);
      const agent = await ownAgent(session.orgId, c.req.param("id"));
      const body = (await c.req.json().catch(() => ({}))) as { versionId?: unknown };

      let versionId = agent.liveVersionId;
      if (typeof body.versionId === "string") {
        if (!UUID.test(body.versionId)) throw new InputError("no such version", 404);
        const owned = await db
          .select({ id: agentVersions.id })
          .from(agentVersions)
          .where(and(eq(agentVersions.id, body.versionId), eq(agentVersions.agentId, agent.id)))
          .limit(1);
        if (!owned[0]) throw new InputError("that is not a version of this agent", 404);
        versionId = body.versionId;
      }
      if (!versionId) throw new InputError("the agent has no version to test");

      const count = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(evalScenarios)
        .where(eq(evalScenarios.agentId, agent.id));
      if ((count[0]?.n ?? 0) === 0) throw new InputError("add a scenario first");

      const run = (
        await db
          .insert(evalRuns)
          .values({ orgId: session.orgId, agentId: agent.id, agentVersionId: versionId, createdBy: session.userId })
          .returning()
      )[0]!;
      try {
        await dispatcher().dispatch(`eval-${run.id.slice(0, 12)}`, { evalRunId: run.id, orgId: session.orgId });
      } catch (error) {
        await db
          .update(evalRuns)
          .set({ status: "failed", error: `could not dispatch: ${(error as Error).message}`, finishedAt: new Date() })
          .where(eq(evalRuns.id, run.id));
        throw new InputError(
          `could not start the test run: ${(error as Error).message}. Run \`uv run evals ${run.id}\` locally instead.`,
          503,
        );
      }
      return c.json({ run }, 202);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/agents/:id/eval-runs", async (c) => {
    try {
      const agent = await ownAgent(c.get("session").orgId, c.req.param("id"));
      const rows = await db
        .select({ run: evalRuns, version: agentVersions.version })
        .from(evalRuns)
        .leftJoin(agentVersions, eq(agentVersions.id, evalRuns.agentVersionId))
        .where(eq(evalRuns.agentId, agent.id))
        .orderBy(desc(evalRuns.createdAt))
        .limit(20);
      return c.json({ runs: rows.map((r) => ({ ...r.run, version: r.version })) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/eval-runs/:id", async (c) => {
    try {
      if (!UUID.test(c.req.param("id"))) throw new InputError("no such run", 404);
      const run = (
        await db
          .select()
          .from(evalRuns)
          .where(and(eq(evalRuns.id, c.req.param("id")), eq(evalRuns.orgId, c.get("session").orgId)))
          .limit(1)
      )[0];
      if (!run) throw new InputError("no such run", 404);
      const results = await db.select().from(evalResults).where(eq(evalResults.runId, run.id)).orderBy(evalResults.createdAt);
      return c.json({ run, results });
    } catch (error) {
      return failure(c, error);
    }
  });

  // --- team ------------------------------------------------------------------------

  app.get("/team", async (c) => {
    const { orgId } = c.get("session");
    const members = await db
      .select({ userId: users.id, email: users.email, name: users.name, role: orgMembers.role, joinedAt: orgMembers.createdAt })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, orgId))
      .orderBy(orgMembers.createdAt);
    const pending = await db
      .select({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt, createdAt: invites.createdAt })
      .from(invites)
      .where(and(eq(invites.orgId, orgId), sql`${invites.acceptedAt} is null and ${invites.expiresAt} > now()`))
      .orderBy(desc(invites.createdAt));
    return c.json({ members, invites: pending });
  });

  /** Invites someone. The response carries the token for the link, once. */
  app.post("/team/invites", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as { email?: unknown; role?: unknown };
      // Only an owner may make another owner.
      if (body.role === "owner" && session.role !== "owner") throw new AuthError("only an owner may invite an owner", 403);
      const { token, invite } = await createInvite(db, session.orgId, session.userId, body.email, body.role);
      return c.json({ token, invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt } }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.delete("/team/invites/:id", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      if (!UUID.test(c.req.param("id"))) throw new InputError("no such invite", 404);
      await db.delete(invites).where(and(eq(invites.id, c.req.param("id")), eq(invites.orgId, session.orgId)));
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.patch("/team/members/:userId", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as { role?: unknown };
      if (!isRole(body.role)) throw new InputError("role must be owner, admin, developer or viewer");
      if (body.role === "owner" && session.role !== "owner") throw new AuthError("only an owner may make an owner", 403);
      if (!UUID.test(c.req.param("userId"))) throw new InputError("no such member", 404);
      await changeMember(db, session.orgId, c.req.param("userId"), body.role);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.delete("/team/members/:userId", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      if (!UUID.test(c.req.param("userId"))) throw new InputError("no such member", 404);
      await changeMember(db, session.orgId, c.req.param("userId"), null);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  // --- privacy ---------------------------------------------------------------------

  /** Erases one person's data, by phone number. See `services/privacy.ts`. */
  app.post("/privacy/erase", async (c) => {
    try {
      const session = c.get("session");
      requireAdmin(session);
      const body = (await c.req.json()) as { phone?: unknown };
      const e164 = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
      if (!e164) throw new InputError("that is not a phone number");
      return c.json({ phone: e164, ...(await erasePhoneNumber(db, session.orgId, e164, recordingStore())) });
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
