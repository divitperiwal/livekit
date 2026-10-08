import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, agentVersions } from "../../src/db/schema";
import { CLINIC_NUMBER, createScenario } from "../http/scenario";

describe("GET /internal/resolve", () => {
  test("a dialled number resolves to its agent's live version", async () => {
    const { resolve, ids } = await createScenario();
    const { status, body } = await resolve({ number: CLINIC_NUMBER });
    expect(status).toBe(200);
    expect(body).toEqual({
      orgId: ids.orgId,
      agentId: ids.agentId,
      agentVersionId: ids.agentVersionId,
      agentSlug: "receptionist",
      promptMode: "prepend_base_rules",
      instructions: "Book appointments for the clinic.",
      greeting: "Namaste, Sharma Clinic.",
      config: { ttsSpeaker: "ritu", ttsPace: 1.1 },
      recordCalls: false,
      availableInr: null,
      tools: [],
      knowledgeBaseCount: 0,
    });
  });

  test("an agent id resolves to its live version; a pinned version to exactly that version", async () => {
    const { resolve, ids } = await createScenario();
    expect((await resolve({ agentId: ids.agentId })).body.agentVersionId).toBe(ids.agentVersionId);
    expect((await resolve({ agentVersionId: ids.agentVersionId })).body.agentVersionId).toBe(
      ids.agentVersionId,
    );
  });

  test("the candidate version takes its percentage of calls", async () => {
    let roll = 0;
    const { resolve, db, ids } = await createScenario({ random: () => roll });
    const [candidate] = await db
      .insert(agentVersions)
      .values({
        orgId: ids.orgId,
        agentId: ids.agentId,
        version: 2,
        promptMode: "verbatim",
        instructions: "Try this.",
        greeting: "Hello.",
        config: {},
      })
      .returning();
    await db
      .update(agents)
      .set({ candidateVersionId: candidate!.id, candidatePercent: 20 })
      .where(eq(agents.id, ids.agentId));

    roll = 0.19;
    expect((await resolve({ agentId: ids.agentId })).body.agentVersionId).toBe(candidate!.id);
    roll = 0.2;
    expect((await resolve({ agentId: ids.agentId })).body.agentVersionId).toBe(ids.agentVersionId);
  });

  test("the org's recording setting and the credit limit reach the worker", async () => {
    const { resolve } = await createScenario({
      org: { recordCalls: true },
      account: { creditCapInr: "250.00" },
    });
    const { body } = await resolve({ number: CLINIC_NUMBER });
    expect(body.recordCalls).toBe(true);
    expect(body.availableInr).toBe(250);
  });

  test("a query naming nothing is a bad request", async () => {
    const { resolve } = await createScenario();
    expect((await resolve({ orgId: "x" })).status).toBe(400);
  });
});
