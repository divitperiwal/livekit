import { and, eq } from "drizzle-orm";
import type { ResolveResponse } from "../../contracts/internal";
import { agents, agentVersions, orgs, phoneNumbers } from "../../db/schema";
import { checkCredit, type CreditCheckDependencies } from "../billing/credit-check";
import { isUuid } from "../ids";

export type ResolveQuery = {
  agentVersionId?: string;
  agentId?: string;
  number?: string;
  /** A claim to check, never a filter. */
  orgId?: string;
};

export type ResolveOutcome =
  | { kind: "resolved"; call: ResolveResponse }
  | { kind: "not_found" | "forbidden" | "no_credit"; reason: string };

export type ResolveDependencies = CreditCheckDependencies & {
  /** [0, 1); decides the candidate split. */
  random?: () => number;
};

type AgentRow = typeof agents.$inferSelect;

const orgDoesNotOwnAgent: ResolveOutcome = {
  kind: "forbidden",
  reason: "org does not own this agent",
};

export function versionToRun(agent: AgentRow, random: () => number): string | null {
  const takesCandidate =
    agent.candidateVersionId !== null && random() * 100 < agent.candidatePercent;
  return takesCandidate ? agent.candidateVersionId : agent.liveVersionId;
}

async function findAgent(db: CreditCheckDependencies["db"], query: ResolveQuery) {
  if (query.agentId) {
    if (!isUuid(query.agentId)) return null;
    const [agent] = await db.select().from(agents).where(eq(agents.id, query.agentId));
    return agent ?? null;
  }
  if (query.number) {
    const [row] = await db
      .select({ agent: agents })
      .from(phoneNumbers)
      .innerJoin(agents, eq(agents.id, phoneNumbers.agentId))
      .where(and(eq(phoneNumbers.e164, query.number), eq(phoneNumbers.status, "assigned")));
    return row?.agent ?? null;
  }
  return null;
}

/**
 * Turns a job into the exact version to run: a pinned version, else the agent's live
 * version (or its candidate, for `candidate_percent` of calls), else the dialled number's
 * agent. Then the org claim (guarantee 2) and the credit check (guarantee 3).
 */
export async function resolveCall(
  dependencies: ResolveDependencies,
  query: ResolveQuery,
): Promise<ResolveOutcome> {
  const { db, random = Math.random } = dependencies;

  let versionId: string | null = null;
  if (query.agentVersionId) {
    if (isUuid(query.agentVersionId)) versionId = query.agentVersionId;
  } else {
    const agent = await findAgent(db, query);
    if (!agent) return { kind: "not_found", reason: "no agent matches" };
    if (query.orgId && query.orgId !== agent.orgId) return orgDoesNotOwnAgent;

    versionId = versionToRun(agent, random);
    if (!versionId) return { kind: "not_found", reason: "agent has no live version" };
  }
  if (!versionId) return { kind: "not_found", reason: "no version matches" };

  const [row] = await db
    .select({ version: agentVersions, agent: agents, org: orgs })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .innerJoin(orgs, eq(orgs.id, agentVersions.orgId))
    .where(eq(agentVersions.id, versionId));
  if (!row) return { kind: "not_found", reason: "no version matches" };
  const { version, agent, org } = row;

  if (query.orgId && query.orgId !== org.id) return orgDoesNotOwnAgent;
  if (org.deletedAt !== null) return { kind: "not_found", reason: "org deleted" };
  if (agent.status !== "active") return { kind: "not_found", reason: "agent archived" };
  if (org.status !== "active") return { kind: "no_credit", reason: "org suspended" };

  const credit = await checkCredit(dependencies, org.accountId, org.externalId);
  if (!credit.allowed) return { kind: "no_credit", reason: credit.reason };

  return {
    kind: "resolved",
    call: {
      orgId: org.id,
      agentId: agent.id,
      agentVersionId: version.id,
      agentSlug: agent.slug,
      promptMode: version.promptMode,
      instructions: version.instructions,
      greeting: version.greeting,
      config: version.config,
      recordCalls: org.recordCalls,
      availableInr: credit.availableInr,
      // Customer tools and knowledge wait for the v1 feature decision.
      tools: [],
      knowledgeBaseCount: 0,
    },
  };
}
