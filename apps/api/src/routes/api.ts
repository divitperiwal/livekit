/**
 * The public API: what the dashboard talks to.
 *
 * Every route below the auth middleware runs with a session, and every query
 * is scoped to that session's organisation. The scoping is not optional and it
 * is not per-handler discipline -- `orgId` comes from the session rather than
 * from anything the caller sent, so a request cannot ask for another tenant's
 * rows by changing a parameter.
 *
 * That is the difference between this and `internal.ts`, which is trusted
 * because only the worker can reach it.
 */

import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { invalidateAgent } from "../cache";
import type { Database } from "../db/client";
import { validateAgentConfig, AgentConfigError, speakersFor } from "../db/validate-config";
import {
  agentKnowledgeBases,
  agents,
  agentTools,
  agentVersions,
  callEvents,
  calls,
  orgBalances,
  orgMembers,
  orgs,
  knowledgeBases,
  phoneNumbers,
  tools,
  usageRecords,
} from "../db/schema";
import {
  AuthError,
  organisationsFor,
  readSession,
  requireWrite,
  signIn,
  signOut,
  switchOrg,
  type Session,
} from "../services/auth";
import { standing } from "../services/ledger";
import { acceptInvite, TeamError } from "../services/team";
import { liveKitDispatcher, type Dispatcher } from "../services/dialer";
import { startTestCall, TestCallError } from "../services/test-call";
import { outboundRoutes } from "./outbound";
import { insightsRoutes } from "./insights";
import { workspaceRoutes } from "./workspace";

const SESSION_COOKIE = "automitra_session";

type Vars = { session: Session; sessionId: string };

/** How the session cookie is set, in one place so it cannot drift. */
function cookie(value: string, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly", // not readable from JavaScript, so XSS cannot steal it
    "SameSite=Lax", // not sent on cross-site POSTs, which covers most CSRF
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * ``dispatcher`` is injectable so tests never reach a real LiveKit project:
 * the default reads credentials from the environment, and a developer's
 * ``.env`` usually has live ones.
 */
export function apiRoutes(db: Database, dispatcher: () => Dispatcher = liveKitDispatcher) {
  const app = new Hono<{ Variables: Vars }>();

  // --- signing in ---------------------------------------------------------

  app.post("/auth/login", async (c) => {
    const body = (await c.req.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    try {
      const { sessionId, session } = await signIn(db, body.email, body.password);
      c.header("Set-Cookie", cookie(sessionId, 60 * 60 * 24));
      return c.json({ email: session.email, orgId: session.orgId, role: session.role });
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  /**
   * Accepts an invitation and signs in. Before the session middleware, since
   * the person accepting may not have an account yet.
   */
  app.post("/auth/accept-invite", async (c) => {
    const body = (await c.req.json()) as { token?: unknown; password?: unknown; name?: unknown };
    try {
      const { email } = await acceptInvite(db, body.token, body.password, body.name);
      const { sessionId, session } = await signIn(db, email, String(body.password));
      c.header("Set-Cookie", cookie(sessionId, 60 * 60 * 24));
      return c.json({ email: session.email, orgId: session.orgId, role: session.role });
    } catch (error) {
      if (error instanceof AuthError || error instanceof TeamError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.post("/auth/logout", async (c) => {
    const sessionId = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    if (sessionId) await signOut(sessionId);
    c.header("Set-Cookie", cookie("", 0));
    return c.json({ ok: true });
  });

  // --- everything past here needs a session -------------------------------

  app.use("*", async (c, next) => {
    const sessionId = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    const session = sessionId ? await readSession(sessionId) : null;
    if (!sessionId || !session) {
      return c.json({ error: "not signed in" }, 401);
    }
    // The session remembers a role, but membership can change under it: a
    // removed member must lose access now, not when the session expires,
    // and a demoted one must lose the old role's rights. One indexed lookup.
    const membership = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, session.orgId), eq(orgMembers.userId, session.userId)))
      .limit(1);
    if (!membership[0]) {
      return c.json({ error: "you are no longer a member of this organisation" }, 401);
    }
    session.role = membership[0].role;
    c.set("session", session);
    c.set("sessionId", sessionId);
    await next();
  });

  app.get("/me", async (c) => {
    const session = c.get("session");
    return c.json({
      email: session.email,
      role: session.role,
      orgId: session.orgId,
      organisations: await organisationsFor(db, session.userId),
    });
  });

  app.post("/me/org", async (c) => {
    const body = (await c.req.json()) as { orgId?: string };
    if (!body.orgId) return c.json({ error: "orgId is required" }, 400);
    try {
      const next = await switchOrg(db, c.get("sessionId"), c.get("session"), body.orgId);
      return c.json({ orgId: next.orgId, role: next.role });
    } catch (error) {
      if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  // --- calls ---------------------------------------------------------------

  app.get("/calls", async (c) => {
    const { orgId } = c.get("session");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const status = c.req.query("status");
    const disposition = c.req.query("disposition");

    const where = and(
      eq(calls.orgId, orgId),
      ...(status ? [eq(calls.status, status as "completed")] : []),
      ...(disposition ? [eq(calls.disposition, disposition)] : []),
    );

    const rows = await db
      .select({
        id: calls.id,
        agentId: calls.agentId,
        agentSlug: agents.slug,
        direction: calls.direction,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        status: calls.status,
        endReason: calls.endReason,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        durationSeconds: calls.durationSeconds,
        costInr: calls.costInr,
        priceInr: calls.priceInr,
        recordingKey: calls.recordingKey,
        disposition: calls.disposition,
        summary: calls.summary,
      })
      .from(calls)
      .leftJoin(agents, eq(agents.id, calls.agentId))
      .where(where)
      .orderBy(desc(calls.startedAt))
      .limit(limit);

    return c.json({ calls: rows });
  });

  app.get("/calls/:id", async (c) => {
    const { orgId } = c.get("session");
    // Scoped by org as well as by id: an id guessed or leaked from elsewhere
    // must not be enough to read another tenant's call.
    const rows = await db
      .select()
      .from(calls)
      .where(and(eq(calls.id, c.req.param("id")), eq(calls.orgId, orgId)))
      .limit(1);

    const call = rows[0];
    if (!call) return c.json({ error: "no such call" }, 404);

    const events = await db
      .select()
      .from(callEvents)
      .where(eq(callEvents.callId, call.id))
      .orderBy(callEvents.seq);

    const usage = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.callId, call.id))
      .limit(1);

    // The event id is a bigserial read as a BigInt, which JSON.stringify
    // refuses; it goes out as a string, which is what the dashboard expects.
    return c.json({
      call,
      events: events.map((event) => ({ ...event, id: String(event.id) })),
      usage: usage[0] ?? null,
    });
  });

  // --- agents --------------------------------------------------------------

  const toolIdsOf = async (versionId: string) =>
    (await db.select({ id: agentTools.toolId }).from(agentTools).where(eq(agentTools.agentVersionId, versionId))).map(
      (r) => r.id,
    );
  const knowledgeBaseIdsOf = async (versionId: string) =>
    (
      await db
        .select({ id: agentKnowledgeBases.knowledgeBaseId })
        .from(agentKnowledgeBases)
        .where(eq(agentKnowledgeBases.agentVersionId, versionId))
    ).map((r) => r.id);

  /**
   * What a new version is given of some kind of attachment: tools, knowledge
   * bases.
   *
   * Omitted means "the same as the version being replaced", so a prompt edit
   * cannot quietly drop them. Every id must be this organisation's: a version
   * must not be able to borrow another tenant's tool, with its credentials,
   * or another tenant's documents.
   */
  async function attachments(
    raw: unknown,
    field: string,
    current: () => Promise<string[]>,
    ownedCount: (ids: string[]) => Promise<number>,
  ): Promise<{ ids: string[] } | { error: string; status: 400 | 422 }> {
    if (raw === undefined) return { ids: await current() };
    if (!Array.isArray(raw) || !raw.every((id): id is string => typeof id === "string")) {
      return { error: `${field} must be a list of ids`, status: 400 };
    }
    const ids = [...new Set(raw)];
    if (ids.length > 0 && (await ownedCount(ids)) !== ids.length) {
      return { error: `${field} names something that is not this organisation's`, status: 422 };
    }
    return { ids };
  }

  app.get("/agents", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        slug: agents.slug,
        description: agents.description,
        status: agents.status,
        liveVersionId: agents.liveVersionId,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .orderBy(agents.name);

    return c.json({ agents: rows });
  });

  app.get("/agents/:id", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param("id")), eq(agents.orgId, orgId)))
      .limit(1);

    const agent = rows[0];
    if (!agent) return c.json({ error: "no such agent" }, 404);

    const versions = await db
      .select({
        id: agentVersions.id,
        version: agentVersions.version,
        publishedAt: agentVersions.publishedAt,
        createdAt: agentVersions.createdAt,
      })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agent.id))
      .orderBy(desc(agentVersions.version));

    const live = agent.liveVersionId
      ? (
          await db
            .select()
            .from(agentVersions)
            .where(eq(agentVersions.id, agent.liveVersionId))
            .limit(1)
        )[0]
      : null;

    return c.json({
      agent,
      versions,
      live,
      toolIds: live ? await toolIdsOf(live.id) : [],
      knowledgeBaseIds: live ? await knowledgeBaseIdsOf(live.id) : [],
    });
  });

  /**
   * Publishes a new version.
   *
   * Never an edit: a new row, then the pointer moves. A call already running
   * holds the version it resolved and is unaffected, and the previous version
   * stays readable for every call record that references it.
   */
  app.post("/agents/:id/versions", async (c) => {
    const session = c.get("session");
    try {
      requireWrite(session);
    } catch (error) {
      if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
      throw error;
    }

    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param("id")), eq(agents.orgId, session.orgId)))
      .limit(1);

    const agent = rows[0];
    if (!agent) return c.json({ error: "no such agent" }, 404);

    const body = (await c.req.json()) as {
      instructions?: string;
      greeting?: string;
      promptMode?: "prepend_base_rules" | "verbatim";
      config?: unknown;
      /**
       * The tools this version may call. Omitted means "the same as the
       * version being replaced", so a prompt edit cannot quietly drop them.
       */
      toolIds?: unknown;
      /** The knowledge bases this version searches, on the same terms. */
      knowledgeBaseIds?: unknown;
    };

    if (!body.instructions?.trim()) {
      return c.json({ error: "instructions are required" }, 400);
    }
    if (!body.greeting?.trim()) {
      return c.json({ error: "a greeting is required" }, 400);
    }

    let config;
    try {
      // The same validation the worker applies when it loads this. A voice
      // that does not exist on the chosen model is rejected here, in a form,
      // rather than at three in the morning on a live call.
      config = validateAgentConfig(body.config ?? {});
    } catch (error) {
      if (error instanceof AgentConfigError) {
        return c.json({ error: error.message, fields: error.fieldErrors }, 422);
      }
      throw error;
    }

    const toolIds = await attachments(
      body.toolIds,
      "toolIds",
      () => (agent.liveVersionId ? toolIdsOf(agent.liveVersionId) : Promise.resolve([])),
      async (ids) =>
        (await db.select({ id: tools.id }).from(tools).where(and(eq(tools.orgId, session.orgId), inArray(tools.id, ids))))
          .length,
    );
    if ("error" in toolIds) return c.json({ error: toolIds.error }, toolIds.status);

    const knowledgeBaseIds = await attachments(
      body.knowledgeBaseIds,
      "knowledgeBaseIds",
      () => (agent.liveVersionId ? knowledgeBaseIdsOf(agent.liveVersionId) : Promise.resolve([])),
      async (ids) =>
        (
          await db
            .select({ id: knowledgeBases.id })
            .from(knowledgeBases)
            .where(and(eq(knowledgeBases.orgId, session.orgId), inArray(knowledgeBases.id, ids)))
        ).length,
    );
    if ("error" in knowledgeBaseIds) return c.json({ error: knowledgeBaseIds.error }, knowledgeBaseIds.status);

    const published = await db.transaction(async (tx) => {
      const counted = await tx
        .select({ next: sql<number>`coalesce(max(${agentVersions.version}), 0) + 1` })
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agent.id));
      const next = counted[0]?.next ?? 1;

      const version = (
        await tx
          .insert(agentVersions)
          .values({
            agentId: agent.id,
            orgId: session.orgId,
            version: next,
            promptMode: body.promptMode ?? "prepend_base_rules",
            instructions: body.instructions!.trim(),
            greeting: body.greeting!.trim(),
            config,
            publishedAt: new Date(),
            publishedBy: session.userId,
          })
          .returning()
      )[0]!;

      if (toolIds.ids.length > 0) {
        await tx
          .insert(agentTools)
          .values(toolIds.ids.map((toolId) => ({ agentVersionId: version.id, toolId })));
      }
      if (knowledgeBaseIds.ids.length > 0) {
        await tx
          .insert(agentKnowledgeBases)
          .values(knowledgeBaseIds.ids.map((knowledgeBaseId) => ({ agentVersionId: version.id, knowledgeBaseId })));
      }

      await tx
        .update(agents)
        .set({ liveVersionId: version.id, draftVersionId: version.id, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      return version;
    });

    // The live pointer is the one cached value that moves. Dropping it makes
    // the publish take effect now rather than within the pointer's short TTL.
    await invalidateAgent(agent.id);

    return c.json({ id: published.id, version: published.version });
  });

  /** The voices available on a model, for the agent form's dropdown. */
  app.get("/voices/:model", (c) => c.json({ speakers: speakersFor(c.req.param("model")) }));

  /**
   * Places a test call from the browser.
   *
   * The same path a phone call takes minus the carrier: the agent is
   * dispatched with this organisation's metadata and the browser joins the
   * room as the other party, so resolution, the transcript and the billing all
   * happen for real.
   */
  app.post("/agents/:id/test-call", async (c) => {
    const session = c.get("session");
    try {
      requireWrite(session);
      const call = await startTestCall(
        db,
        session.orgId,
        c.req.param("id"),
        session.email,
      );
      return c.json(call);
    } catch (error) {
      if (error instanceof TestCallError) return c.json({ error: error.message }, error.status);
      if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  // --- numbers -------------------------------------------------------------

  app.get("/numbers", async (c) => {
    const { orgId } = c.get("session");
    const rows = await db
      .select({
        id: phoneNumbers.id,
        e164: phoneNumbers.e164,
        provider: phoneNumbers.provider,
        direction: phoneNumbers.direction,
        status: phoneNumbers.status,
        agentId: phoneNumbers.agentId,
        agentSlug: agents.slug,
      })
      .from(phoneNumbers)
      .leftJoin(agents, eq(agents.id, phoneNumbers.agentId))
      .where(eq(phoneNumbers.orgId, orgId))
      .orderBy(phoneNumbers.e164);

    return c.json({ numbers: rows });
  });

  app.post("/numbers/:id/agent", async (c) => {
    const session = c.get("session");
    try {
      requireWrite(session);
    } catch (error) {
      if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
      throw error;
    }

    const body = (await c.req.json()) as { agentId?: string | null };

    // Both the number and the agent are checked against this session's
    // organisation, so neither half of the pairing can point outside it.
    if (body.agentId) {
      const owns = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, body.agentId), eq(agents.orgId, session.orgId)))
        .limit(1);
      if (owns.length === 0) return c.json({ error: "no such agent" }, 404);
    }

    const updated = await db
      .update(phoneNumbers)
      .set({ agentId: body.agentId ?? null, updatedAt: new Date() })
      .where(
        and(eq(phoneNumbers.id, c.req.param("id")), eq(phoneNumbers.orgId, session.orgId)),
      )
      .returning();

    if (updated.length === 0) return c.json({ error: "no such number" }, 404);
    return c.json({ id: updated[0]!.id, agentId: updated[0]!.agentId });
  });

  app.route("/", outboundRoutes(db));
  app.route("/", workspaceRoutes(db));
  app.route("/", insightsRoutes(db, dispatcher));

  // --- usage ---------------------------------------------------------------

  app.get("/usage", async (c) => {
    const { orgId } = c.get("session");
    const days = Math.min(Number(c.req.query("days") ?? 30), 365);

    const [balance, daily, review] = await Promise.all([
      standing(db, orgId),
      db
        .select({
          day: usageRecords.periodStart,
          calls: sql<number>`count(*)::int`,
          seconds: sql<number>`coalesce(sum(${usageRecords.billableSeconds}), 0)::int`,
          costInr: sql<string>`coalesce(sum(${usageRecords.costTotalInr}), 0)`,
          priceInr: sql<string>`coalesce(sum(${usageRecords.priceInr}), 0)`,
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.orgId, orgId),
            sql`${usageRecords.periodStart} >= current_date - make_interval(days => ${days})`,
          ),
        )
        .groupBy(usageRecords.periodStart)
        .orderBy(desc(usageRecords.periodStart)),
      // Surfaced rather than hidden: a row the platform could not price is a
      // number somebody has to look at.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageRecords)
        .where(and(eq(usageRecords.orgId, orgId), eq(usageRecords.needsReview, true))),
    ]);

    return c.json({
      balanceInr: balance.balanceInr,
      creditLimitInr: balance.creditLimitInr,
      canPlaceCalls: balance.canPlaceCalls,
      daily,
      needsReview: review[0]?.count ?? 0,
    });
  });

  return app;
}
