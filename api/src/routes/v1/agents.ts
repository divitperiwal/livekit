import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { parseJsonBody } from "../../http/validate";
import {
  agentInputSchema,
  archiveAgent,
  createAgent,
  findAgent,
  listAgents,
  listVersions,
  publishVersion,
  saveDraft,
  setExperiment,
  toPublicAgent,
  toPublicVersion,
  versionInputSchema,
  type AgentOutcome,
} from "../../modules/agents/agents";

const publishSchema = z.strictObject({ versionId: z.string().optional() });
const experimentSchema = z.strictObject({
  versionId: z.string().nullable().default(null),
  percent: z.number().int().min(0).max(99),
});

type AgentSaved = Extract<AgentOutcome, { kind: "ok" }>;

function savedOrThrow(outcome: AgentOutcome): AgentSaved {
  switch (outcome.kind) {
    case "ok":
      return outcome;
    case "invalid_config":
      throw new HttpError(422, `invalid config: ${outcome.problems.join("; ")}`);
    case "not_found":
      throw new HttpError(404, outcome.reason);
    case "conflict":
    case "archived":
      throw new HttpError(409, outcome.reason);
  }
}

const actor = (keyId: string) => `key:${keyId}`;

/** Mounted under /v1/orgs/:externalId/agents, behind requireOrg. */
export function agentRoutes({ db }: AppDependencies) {
  return new Hono<V1Env>()
    .get("/", requireScope("orgs:read"), async (c) => {
      const agents = await listAgents(db, c.get("org").id);
      return c.json({ agents: agents.map(toPublicAgent) });
    })
    .post("/", requireScope("orgs:write"), async (c) => {
      const input = await parseJsonBody(c, agentInputSchema);
      const { agent } = savedOrThrow(await createAgent(db, c.get("org").id, input));
      return c.json(toPublicAgent(agent), 201);
    })
    .get("/:agentId", requireScope("orgs:read"), async (c) => {
      const agent = await findAgent(db, c.get("org").id, c.req.param("agentId"));
      if (!agent) throw new HttpError(404, "agent not found");
      return c.json(toPublicAgent(agent));
    })
    .delete("/:agentId", requireScope("orgs:write"), async (c) => {
      const outcome = await archiveAgent(db, c.get("org").id, c.req.param("agentId"));
      return c.json(toPublicAgent(savedOrThrow(outcome).agent));
    })
    .get("/:agentId/versions", requireScope("orgs:read"), async (c) => {
      const agent = await findAgent(db, c.get("org").id, c.req.param("agentId"));
      if (!agent) throw new HttpError(404, "agent not found");
      const versions = await listVersions(db, agent.id);
      return c.json({ versions: versions.map(toPublicVersion) });
    })
    .put("/:agentId/draft", requireScope("orgs:write"), async (c) => {
      const input = await parseJsonBody(c, versionInputSchema);
      const outcome = await saveDraft(db, c.get("org").id, c.req.param("agentId"), input);
      const { agent, version } = savedOrThrow(outcome);
      return c.json({ agent: toPublicAgent(agent), version: toPublicVersion(version!) }, 201);
    })
    .post("/:agentId/publish", requireScope("orgs:write"), async (c) => {
      const { versionId } = await parseJsonBody(c, publishSchema);
      const publishedBy = actor(c.get("apiKey").keyId);
      const outcome = await publishVersion(
        db,
        c.get("org").id,
        c.req.param("agentId"),
        versionId,
        publishedBy,
      );
      return c.json(toPublicAgent(savedOrThrow(outcome).agent));
    })
    .put("/:agentId/experiment", requireScope("orgs:write"), async (c) => {
      const input = await parseJsonBody(c, experimentSchema);
      const publishedBy = actor(c.get("apiKey").keyId);
      const outcome = await setExperiment(
        db,
        c.get("org").id,
        c.req.param("agentId"),
        input,
        publishedBy,
      );
      return c.json(toPublicAgent(savedOrThrow(outcome).agent));
    });
}
