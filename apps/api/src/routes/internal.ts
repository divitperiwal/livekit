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

import { cachedLiveVersion, cachedVersion } from "../cache";
import type { Database } from "../db/client";
import {
  assertOwnedBy,
  ResolutionError,
  type ResolvedAgent,
  resolveByAgentId,
  resolveByDialledNumber,
  resolveByVersionId,
} from "../services/agent-resolution";
import { standing, type Standing } from "../services/ledger";
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
   * Checks the organisation can pay, and tells the worker what is left.
   *
   * Applied on every resolution path rather than just one: an organisation out
   * of credit must not be reachable by a different route.
   */
  async function withStanding(resolved: ResolvedAgent) {
    const s = await assertSolvent(resolved.orgId);
    return { ...resolved, availableInr: s.availableInr };
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
        // The live pointer moves on publish, so it is cached only briefly.
        const resolved = await cachedLiveVersion(agentId, () =>
          resolveByAgentId(db, agentId),
        );
        assertOwnedBy(resolved, orgId);
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
