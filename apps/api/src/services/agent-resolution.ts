/**
 * Turning a call into the agent configuration it should run on.
 *
 * Two ways in. A job carrying metadata names the agent version directly, which
 * is how an outbound call and a provisioned inbound number both work. A job
 * carrying nothing but the number that was dialled has to be looked up, which
 * is the fallback while numbers are still being provisioned.
 *
 * Either way the answer is a *version*, never an agent. The version is what a
 * call pins for its lifetime, so publishing a new prompt mid-call cannot
 * change a conversation already in progress.
 */

import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { agents, agentVersions, orgs, phoneNumbers } from "../db/schema";

export interface ResolvedAgent {
  orgId: string;
  agentId: string;
  agentVersionId: string;
  agentSlug: string;
  /** How the prompt combines with the shared voice rules. */
  promptMode: "prepend_base_rules" | "verbatim";
  instructions: string;
  greeting: string;
  config: unknown;
  /** Whether this organisation has opted into recording. */
  recordCalls: boolean;
}

export class ResolutionError extends Error {
  constructor(
    message: string,
    // 402 when the organisation is out of credit: a real refusal to serve,
    // distinct from "not found" or "not yours".
    readonly status: 402 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

/**
 * Refuses a resolved agent that does not belong to the org the caller claimed.
 *
 * Separate from the queries because it has to run on a *cached* answer too.
 * The cache is keyed on the thing being looked up, not on who is asking -- so
 * a check that lived only inside the loader would hold on a cache miss and
 * lapse on a hit, which is the worse of the two failure modes because it looks
 * correct in testing.
 */
export function assertOwnedBy(
  resolved: ResolvedAgent,
  expectedOrgId: string | undefined,
): void {
  if (expectedOrgId && resolved.orgId !== expectedOrgId) {
    throw new ResolutionError(
      `agent ${resolved.agentId} does not belong to org ${expectedOrgId}`,
      403,
    );
  }
}

/** Shapes a version row into what the worker consumes. */
function present(row: {
  version: typeof agentVersions.$inferSelect;
  agentSlug: string;
  recordCalls: boolean;
}): ResolvedAgent {
  return {
    orgId: row.version.orgId,
    agentId: row.version.agentId,
    agentVersionId: row.version.id,
    agentSlug: row.agentSlug,
    promptMode: row.version.promptMode,
    instructions: row.version.instructions,
    greeting: row.version.greeting,
    config: row.version.config,
    recordCalls: row.recordCalls,
  };
}

/**
 * Loads one version by id.
 *
 * `orgId` is not taken on trust from whoever asked. The caller states which
 * organisation it believes the version belongs to, and a mismatch is refused
 * rather than served -- otherwise a job whose metadata named someone else's
 * version would quietly hand one tenant another tenant's prompt.
 */
export async function resolveByVersionId(
  db: Database,
  versionId: string,
  expectedOrgId?: string,
): Promise<ResolvedAgent> {
  const rows = await db
    .select({ version: agentVersions, agentSlug: agents.slug, recordCalls: orgs.recordCalls })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .innerJoin(orgs, eq(orgs.id, agentVersions.orgId))
    .where(eq(agentVersions.id, versionId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new ResolutionError(`agent version ${versionId} not found`, 404);
  }
  if (expectedOrgId && row.version.orgId !== expectedOrgId) {
    throw new ResolutionError(
      `agent version ${versionId} does not belong to org ${expectedOrgId}`,
      403,
    );
  }
  return present(row);
}

export interface AgentRouting {
  agentId: string;
  orgId: string;
  liveVersionId: string | null;
  candidateVersionId: string | null;
  candidatePercent: number;
}

/** Where an agent's calls go: its live version, and any experiment. */
export async function agentRouting(db: Database, agentId: string): Promise<AgentRouting> {
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (!agent) throw new ResolutionError(`agent ${agentId} not found`, 404);
  if (!agent.liveVersionId) {
    throw new ResolutionError(`agent ${agent.slug} has no published version`, 409);
  }
  return {
    agentId: agent.id,
    orgId: agent.orgId,
    liveVersionId: agent.liveVersionId,
    candidateVersionId: agent.candidateVersionId,
    candidatePercent: agent.candidatePercent,
  };
}

/**
 * Picks the version one call runs on: the candidate for its share of calls,
 * the live version for the rest. `random` is in [0, 1).
 */
export function pickVersion(routing: AgentRouting, random: number = Math.random()): string {
  if (routing.candidateVersionId && routing.candidatePercent > 0 && random * 100 < routing.candidatePercent) {
    return routing.candidateVersionId;
  }
  return routing.liveVersionId!;
}

/**
 * The version a call to this agent runs on, experiment included.
 *
 * A candidate that cannot be loaded falls back to the live version rather
 * than failing the call: an experiment is optional, answering the phone is
 * not.
 */
export async function resolveRouted(
  routing: AgentRouting,
  load: (versionId: string) => Promise<ResolvedAgent>,
  random: number = Math.random(),
): Promise<ResolvedAgent> {
  const versionId = pickVersion(routing, random);
  if (versionId === routing.liveVersionId) return load(versionId);
  try {
    return await load(versionId);
  } catch {
    return load(routing.liveVersionId!);
  }
}

/** Loads the version a call to this agent should run on now. */
export async function resolveByAgentId(
  db: Database,
  agentId: string,
  expectedOrgId?: string,
): Promise<ResolvedAgent> {
  const routing = await agentRouting(db, agentId);
  if (expectedOrgId && routing.orgId !== expectedOrgId) {
    throw new ResolutionError(
      `agent ${agentId} does not belong to org ${expectedOrgId}`,
      403,
    );
  }
  return resolveRouted(routing, (versionId) => resolveByVersionId(db, versionId));
}

/**
 * Looks up which agent answers a dialled number.
 *
 * The fallback path, used when a job arrives with no metadata -- either
 * because the number's dispatch rule has not been provisioned yet, or because
 * a generic catch-all rule handled the call.
 */
export async function resolveByDialledNumber(
  db: Database,
  e164: string,
): Promise<ResolvedAgent> {
  const rows = await db
    .select({ number: phoneNumbers })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.e164, e164), eq(phoneNumbers.status, "assigned")))
    .limit(1);

  const number = rows[0]?.number;
  if (!number) {
    throw new ResolutionError(`no assigned number ${e164}`, 404);
  }
  if (!number.agentId) {
    throw new ResolutionError(`number ${e164} has no agent`, 409);
  }
  return resolveByAgentId(db, number.agentId, number.orgId ?? undefined);
}
