import { and, asc, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { onlyRow, type Database, type DatabaseTransaction } from "../../db/database";
import { agents, agentVersions, phoneNumbers } from "../../db/schema";
import { isUuid } from "../ids";
import { validateAgentConfig } from "./agent-config";

export const AGENT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const versionInputSchema = z.strictObject({
  promptMode: z.enum(["prepend_base_rules", "verbatim"]).default("prepend_base_rules"),
  instructions: z.string().trim().min(1).max(20_000),
  greeting: z.string().trim().min(1).max(1_000),
  /** Stored camelCase `AgentConfigModel`; checked as the worker checks it. */
  config: z.record(z.string(), z.unknown()).default({}),
});
export const agentInputSchema = versionInputSchema.extend({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(AGENT_SLUG, "lowercase letters, digits and dashes"),
});
export type VersionInput = z.output<typeof versionInputSchema>;
export type AgentInput = z.output<typeof agentInputSchema>;

type AgentRow = typeof agents.$inferSelect;
type VersionRow = typeof agentVersions.$inferSelect;

export const toPublicAgent = (agent: AgentRow) => ({
  id: agent.id,
  name: agent.name,
  slug: agent.slug,
  status: agent.status,
  draftVersionId: agent.draftVersionId,
  liveVersionId: agent.liveVersionId,
  candidateVersionId: agent.candidateVersionId,
  candidatePercent: agent.candidatePercent,
  createdAt: agent.createdAt.toISOString(),
  updatedAt: agent.updatedAt.toISOString(),
});

export const toPublicVersion = (version: VersionRow) => ({
  id: version.id,
  version: version.version,
  promptMode: version.promptMode,
  instructions: version.instructions,
  greeting: version.greeting,
  config: version.config,
  publishedAt: version.publishedAt?.toISOString() ?? null,
  createdAt: version.createdAt.toISOString(),
});

export type AgentOutcome =
  | { kind: "ok"; agent: AgentRow; version?: VersionRow }
  | { kind: "invalid_config"; problems: string[] }
  | { kind: "not_found" | "conflict" | "archived"; reason: string };

const agentNotFound: AgentOutcome = { kind: "not_found", reason: "agent not found" };
const agentArchived: AgentOutcome = { kind: "archived", reason: "agent is archived" };
const versionNotFound: AgentOutcome = { kind: "not_found", reason: "version not found" };

function configProblems(config: Record<string, unknown>): string[] | null {
  const result = validateAgentConfig(config);
  return result.valid ? null : result.problems;
}

async function insertVersion(
  tx: DatabaseTransaction,
  agent: AgentRow,
  version: number,
  input: VersionInput,
): Promise<VersionRow> {
  return tx
    .insert(agentVersions)
    .values({ orgId: agent.orgId, agentId: agent.id, version, ...input })
    .returning()
    .then(onlyRow);
}

/** The agent is locked by the caller's transaction, so the update always returns it. */
async function updateAgent(
  tx: DatabaseTransaction,
  agentId: string,
  changes: Partial<typeof agents.$inferInsert>,
): Promise<AgentRow> {
  return tx.update(agents).set(changes).where(eq(agents.id, agentId)).returning().then(onlyRow);
}

async function lockAgent(tx: DatabaseTransaction, orgId: string, agentId: string) {
  if (!isUuid(agentId)) return null;
  const [agent] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .for("update");
  return agent ?? null;
}

async function findVersion(tx: DatabaseTransaction, agent: AgentRow, versionId: string | null) {
  if (!isUuid(versionId)) return null;
  const [version] = await tx
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, agent.id)));
  return version ?? null;
}

/** Stamped once, when a version first takes calls. */
async function stampPublished(
  tx: DatabaseTransaction,
  version: VersionRow,
  publishedBy: string,
  now: Date,
) {
  if (version.publishedAt !== null) return;
  await tx
    .update(agentVersions)
    .set({ publishedAt: now, publishedBy })
    .where(eq(agentVersions.id, version.id));
}

/** A new agent and its first version, as the draft. Nothing answers calls until it is published. */
export async function createAgent(
  db: Database,
  orgId: string,
  input: AgentInput,
): Promise<AgentOutcome> {
  const problems = configProblems(input.config);
  if (problems) return { kind: "invalid_config", problems };

  const { name, slug, ...versionInput } = input;
  return db.transaction(async (tx): Promise<AgentOutcome> => {
    const [agent] = await tx
      .insert(agents)
      .values({ orgId, name, slug })
      .onConflictDoNothing({ target: [agents.orgId, agents.slug] })
      .returning();
    if (!agent) return { kind: "conflict", reason: `an agent with slug ${slug} exists` };

    const firstVersion = await insertVersion(tx, agent, 1, versionInput);
    return {
      kind: "ok",
      agent: await updateAgent(tx, agent.id, { draftVersionId: firstVersion.id }),
    };
  });
}

/** Saving never edits a version (guarantee 16): it writes the next one and moves the draft pointer. */
export async function saveDraft(
  db: Database,
  orgId: string,
  agentId: string,
  input: VersionInput,
): Promise<AgentOutcome> {
  const problems = configProblems(input.config);
  if (problems) return { kind: "invalid_config", problems };

  return db.transaction(async (tx): Promise<AgentOutcome> => {
    const agent = await lockAgent(tx, orgId, agentId);
    if (!agent) return agentNotFound;
    if (agent.status !== "active") return agentArchived;

    const [latest] = await tx
      .select({ version: max(agentVersions.version) })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agent.id));
    const nextVersionNumber = (latest?.version ?? 0) + 1;
    const version = await insertVersion(tx, agent, nextVersionNumber, input);
    return {
      kind: "ok",
      agent: await updateAgent(tx, agent.id, { draftVersionId: version.id }),
      version,
    };
  });
}

/** Makes a version (default: the draft) live. Ends any experiment on that same version. */
export async function publishVersion(
  db: Database,
  orgId: string,
  agentId: string,
  versionId: string | undefined,
  publishedBy: string,
  now = new Date(),
): Promise<AgentOutcome> {
  return db.transaction(async (tx): Promise<AgentOutcome> => {
    const agent = await lockAgent(tx, orgId, agentId);
    if (!agent) return agentNotFound;
    if (agent.status !== "active") return agentArchived;

    const version = await findVersion(tx, agent, versionId ?? agent.draftVersionId);
    if (!version) return versionNotFound;

    await stampPublished(tx, version, publishedBy, now);
    const candidateWentLive = agent.candidateVersionId === version.id;
    const endExperiment = { candidateVersionId: null, candidatePercent: 0 };
    return {
      kind: "ok",
      agent: await updateAgent(tx, agent.id, {
        liveVersionId: version.id,
        ...(candidateWentLive ? endExperiment : {}),
      }),
    };
  });
}

/** Sends `percent` of calls to a candidate version; percent 0 ends the experiment. */
export async function setExperiment(
  db: Database,
  orgId: string,
  agentId: string,
  input: { versionId: string | null; percent: number },
  publishedBy: string,
  now = new Date(),
): Promise<AgentOutcome> {
  return db.transaction(async (tx): Promise<AgentOutcome> => {
    const agent = await lockAgent(tx, orgId, agentId);
    if (!agent) return agentNotFound;
    if (agent.status !== "active") return agentArchived;

    if (input.percent === 0) {
      return {
        kind: "ok",
        agent: await updateAgent(tx, agent.id, { candidateVersionId: null, candidatePercent: 0 }),
      };
    }

    if (!agent.liveVersionId) {
      return { kind: "conflict", reason: "publish a live version before starting an experiment" };
    }
    const version = await findVersion(tx, agent, input.versionId);
    if (!version) return versionNotFound;
    if (version.id === agent.liveVersionId) {
      return { kind: "conflict", reason: "the candidate must differ from the live version" };
    }

    await stampPublished(tx, version, publishedBy, now);
    return {
      kind: "ok",
      agent: await updateAgent(tx, agent.id, {
        candidateVersionId: version.id,
        candidatePercent: input.percent,
      }),
    };
  });
}

/** Stops it taking calls; its numbers stay with the org, pointing at no agent. */
export async function archiveAgent(
  db: Database,
  orgId: string,
  agentId: string,
): Promise<AgentOutcome> {
  return db.transaction(async (tx): Promise<AgentOutcome> => {
    const agent = await lockAgent(tx, orgId, agentId);
    if (!agent) return agentNotFound;

    await tx.update(phoneNumbers).set({ agentId: null }).where(eq(phoneNumbers.agentId, agent.id));
    return { kind: "ok", agent: await updateAgent(tx, agent.id, { status: "archived" }) };
  });
}

export async function findAgent(db: Database, orgId: string, agentId: string) {
  if (!isUuid(agentId)) return null;
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  return agent ?? null;
}

export function listAgents(db: Database, orgId: string) {
  return db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(asc(agents.slug));
}

export function listVersions(db: Database, agentId: string) {
  return db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version));
}
