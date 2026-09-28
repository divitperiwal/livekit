/**
 * The internal API: what the worker talks to.
 *
 * These endpoints serve any tenant's configuration and accept writes against
 * any call, so they carry no per-tenant authorisation of their own -- the
 * worker is trusted, and the boundary is the network plus a shared secret.
 * They must never be exposed publicly.
 *
 * Everything here is either a read on the path a caller is waiting through, or
 * an idempotent write. Both shape the design: the reads are cached and the
 * writes can all be retried.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { cachedRouting, cachedVersion } from "../cache";
import type { Database } from "../db/client";
import { evalResults, evalRuns, evalScenarios } from "../db/schema";
import {
  assertOwnedBy,
  ResolutionError,
  type ResolvedAgent,
  agentRouting,
  resolveRouted,
  resolveByDialledNumber,
  resolveByVersionId,
} from "../services/agent-resolution";
import { standing, type Standing } from "../services/ledger";
import { knowledgeBaseCount, searchKnowledge } from "../services/knowledge";
import { toolsForVersion } from "../services/tools";
import {
  appendEvents,
  finalizeCall,
  startCall,
  type CallEventInput,
} from "../services/calls";

export function internalRoutes(db: Database) {
  const app = new Hono();

  /**
   * Refuses a call from an organisation that cannot pay for it.
   *
   * Checked here, before the agent is handed over, because a refusal is only
   * worth anything while it can still prevent the spend. A 402 tells the
   * worker to end the call rather than answer it.
   *
   * `availableInr` goes back with it so the worker can cap the call's own
   * budget to whatever is left, which bounds how far a single long call can
   * overdraw between this check and the charge at the end.
   */
  async function assertSolvent(orgId: string): Promise<Standing> {
    const s = await standing(db, orgId);
    if (!s.canPlaceCalls) {
      throw new ResolutionError(
        `org ${orgId} has no credit remaining (balance Rs ${s.balanceInr.toFixed(2)})`,
        402,
      );
    }
    return s;
  }

  /**
   * Checks the organisation can pay, tells the worker what is left, and hands
   * over the version's tools.
   *
   * Applied on every resolution path rather than just one: an organisation out
   * of credit must not be reachable by a different route.
   *
   * The tools are attached here, after the cache, rather than inside it: they
   * carry decrypted credentials, which must never be written to Redis, and a
   * tool row can be edited or disabled while the version it hangs off cannot.
   */
  async function withStanding(resolved: ResolvedAgent) {
    const s = await assertSolvent(resolved.orgId);
    return {
      ...resolved,
      availableInr: s.availableInr,
      tools: await toolsForVersion(db, resolved.agentVersionId),
      knowledgeBaseCount: await knowledgeBaseCount(db, resolved.agentVersionId),
    };
  }

  /**
   * Resolve the agent for a call.
   *
   * Three ways to ask, in order of directness: by version (a job whose
   * metadata pinned one), by agent (metadata naming the agent, so whatever is
   * live now), or by the number that was dialled (the fallback for a job with
   * no metadata at all).
   *
   * `orgId` is a claim to be checked, not a filter to apply. Resolution
   * refuses a mismatch rather than serving it, so a job whose metadata named
   * another tenant's version gets an error instead of that tenant's prompt.
   */
  app.get("/resolve", async (c) => {
    const versionId = c.req.query("agentVersionId");
    const agentId = c.req.query("agentId");
    const number = c.req.query("number");
    const orgId = c.req.query("orgId") ?? undefined;

    try {
      if (versionId) {
        // Immutable, so this may be cached for a long time.
        //
        // The cache key deliberately excludes orgId, and the ownership check
        // therefore has to happen on the way out rather than inside the
        // loader. Keying on the claim instead would let a caller who states
        // the right org populate an entry, and a later caller stating the
        // wrong one read it straight back -- a check that holds on a cache
        // miss and silently lapses on a hit.
        const resolved = await cachedVersion(versionId, () =>
          resolveByVersionId(db, versionId),
        );
        assertOwnedBy(resolved, orgId);
        return c.json(await withStanding(resolved));
      }

      if (agentId) {
        // The routing moves on publish and on experiment changes, so it is
        // cached only briefly; the version it picks is immutable and cached
        // for long. The ownership check runs on the routing, before any
        // version is loaded, for the same warm-cache reason as above.
        const routing = await cachedRouting(agentId, () => agentRouting(db, agentId));
        if (orgId && routing.orgId !== orgId) {
          throw new ResolutionError(`agent ${agentId} does not belong to org ${orgId}`, 403);
        }
        const resolved = await resolveRouted(routing, (id) =>
          cachedVersion(id, () => resolveByVersionId(db, id)),
        );
        return c.json(await withStanding(resolved));
      }

      if (number) {
        return c.json(await withStanding(await resolveByDialledNumber(db, number)));
      }

      return c.json(
        { error: "pass agentVersionId, agentId or number" },
        400,
      );
    } catch (error) {
      if (error instanceof ResolutionError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  /**
   * Passages from a version's knowledge bases, for the agent's
   * `search_knowledge` tool. `orgId` is required here, not merely checked:
   * the search is scoped by it, so the worker cannot be talked into reading
   * another tenant's documents by a version id alone.
   */
  app.get("/knowledge/search", async (c) => {
    const versionId = c.req.query("agentVersionId");
    const orgId = c.req.query("orgId");
    const q = c.req.query("q") ?? "";
    if (!versionId || !orgId) return c.json({ error: "agentVersionId and orgId are required" }, 400);
    return c.json({ passages: await searchKnowledge(db, orgId, versionId, q.slice(0, 500)) });
  });

  // --- test runs --------------------------------------------------------------

  /**
   * A test run as the worker plays it: the scenarios, and the version under
   * test resolved exactly as a call would be, tools and knowledge included.
   * Marks the run as running.
   */
  app.get("/eval-runs/:id", async (c) => {
    const run = (await db.select().from(evalRuns).where(eq(evalRuns.id, c.req.param("id"))).limit(1))[0];
    if (!run) return c.json({ error: "no such run" }, 404);
    if (!run.agentVersionId) return c.json({ error: "the version under test no longer exists" }, 409);
    const resolved = await resolveByVersionId(db, run.agentVersionId, run.orgId);
    const scenarios = await db.select().from(evalScenarios).where(eq(evalScenarios.agentId, run.agentId));
    await db.update(evalRuns).set({ status: "running" }).where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, "queued")));
    return c.json({
      run,
      scenarios,
      agent: {
        ...resolved,
        tools: await toolsForVersion(db, resolved.agentVersionId),
        knowledgeBaseCount: await knowledgeBaseCount(db, resolved.agentVersionId),
      },
    });
  });

  /** One scenario's result. Idempotent on (run, scenario): a retry replaces it. */
  app.post("/eval-runs/:id/results", async (c) => {
    const body = (await c.req.json()) as {
      scenarioId: string;
      passed: boolean;
      transcript: unknown;
      judgments: unknown;
      turns: number;
      error?: string | null;
      tokens?: number;
    };
    const scenario = (
      await db.select({ name: evalScenarios.name }).from(evalScenarios).where(eq(evalScenarios.id, body.scenarioId)).limit(1)
    )[0];
    const values = {
      runId: c.req.param("id"),
      scenarioId: body.scenarioId,
      scenarioName: scenario?.name ?? "(deleted scenario)",
      passed: body.passed === true,
      transcript: body.transcript ?? [],
      judgments: body.judgments ?? [],
      turns: Number(body.turns) || 0,
      error: body.error ?? null,
      tokens: Number(body.tokens) || 0,
    };
    await db
      .insert(evalResults)
      .values(values)
      .onConflictDoUpdate({ target: [evalResults.runId, evalResults.scenarioId], set: values });
    return c.json({ ok: true });
  });

  app.post("/eval-runs/:id/finish", async (c) => {
    const body = (await c.req.json()) as { status?: string; passed?: number; total?: number; tokens?: number; error?: string };
    await db
      .update(evalRuns)
      .set({
        status: body.status === "completed" ? "completed" : "failed",
        passed: body.passed ?? null,
        total: body.total ?? null,
        tokens: body.tokens ?? null,
        error: body.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(evalRuns.id, c.req.param("id")));
    return c.json({ ok: true });
  });

  /** Open a call record. Idempotent on the LiveKit job id. */
  app.post("/calls", async (c) => {
    const body = await c.req.json();
    const call = await startCall(db, body);
    return c.json({ id: call.id, orgId: call.orgId });
  });

  /** Append transcript turns and other events. Idempotent on (call, seq). */
  app.post("/calls/:id/events", async (c) => {
    const callId = c.req.param("id");
    const body = (await c.req.json()) as {
      orgId: string;
      events: CallEventInput[];
    };
    const written = await appendEvents(db, callId, body.orgId, body.events);
    return c.json({ written, received: body.events.length });
  });

  /** Close a call and record what it used. Safe to call more than once. */
  app.post("/calls/:id/finalize", async (c) => {
    const callId = c.req.param("id");
    const body = await c.req.json();
    const call = await finalizeCall(db, callId, body);
    return c.json({ id: call.id, status: call.status });
  });

  return app;
}
