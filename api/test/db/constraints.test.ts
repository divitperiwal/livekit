import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, calls, webhookDeliveries, webhookEndpoints } from "../../src/db/schema";
import { seedAccount, seedAgentWithVersion, seedOrg } from "./seed";
import { createTestDatabase, postgresError } from "./test-database";

async function twoOrgsWithAgents() {
  const { db } = await createTestDatabase();
  const account = await seedAccount(db);
  const orgA = await seedOrg(db, account.id, "biz-a");
  const orgB = await seedOrg(db, account.id, "biz-b");
  const a = await seedAgentWithVersion(db, orgA.id);
  const b = await seedAgentWithVersion(db, orgB.id);
  return { db, account, orgA, orgB, a, b };
}

describe("tenancy is enforced by the keys themselves", () => {
  test("an agent cannot point at another agent's version", async () => {
    const { db, a, b } = await twoOrgsWithAgents();
    const error = await postgresError(
      db.update(agents).set({ liveVersionId: b.version.id }).where(eq(agents.id, a.agent.id)),
    );
    expect(error.constraint).toBe("agents_live_version_fk");
  });

  test("a call cannot run another org's version", async () => {
    const { db, orgA, a, b } = await twoOrgsWithAgents();
    const error = await postgresError(
      db.insert(calls).values({
        orgId: orgA.id,
        agentId: a.agent.id,
        agentVersionId: b.version.id,
        lkJobId: "job-1",
        direction: "inbound",
        status: "in_progress",
      }),
    );
    expect(error.constraint).toBe("calls_agent_version_fk");
  });

  test("the same external id may exist under two accounts, not twice under one", async () => {
    const { db, account } = await twoOrgsWithAgents();
    const other = await seedAccount(db, "outside-client");
    await seedOrg(db, other.id, "biz-a");
    const error = await postgresError(seedOrg(db, account.id, "biz-a"));
    expect(error.constraint).toBe("orgs_account_external_id_key");
  });
});

describe("calls", () => {
  test("only a queued call may exist before a worker opened it", async () => {
    const { db, orgA, a } = await twoOrgsWithAgents();
    const base = {
      orgId: orgA.id,
      agentId: a.agent.id,
      agentVersionId: a.version.id,
      direction: "outbound" as const,
    };
    await db.insert(calls).values({ ...base, status: "queued", requestId: crypto.randomUUID() });
    const error = await postgresError(db.insert(calls).values({ ...base, status: "ringing" }));
    expect(error.constraint).toBe("calls_opened_has_job");
  });
});

describe("webhook deliveries", () => {
  test("usage.recorded can never be marked failed", async () => {
    const { db, account } = await twoOrgsWithAgents();
    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        accountId: account.id,
        url: "https://example.com/hook",
        secretCiphertext: "x",
        events: ["usage.recorded"],
      })
      .returning();
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        endpointId: endpoint!.id,
        event: "usage.recorded",
        eventKey: "usage-1",
        payload: {},
      })
      .returning();
    const error = await postgresError(
      db
        .update(webhookDeliveries)
        .set({ status: "failed" })
        .where(eq(webhookDeliveries.id, delivery!.id)),
    );
    expect(error.constraint).toBe("webhook_deliveries_usage_never_fails");
  });

  test("call.ended and usage.recorded for the same call are separate deliveries", async () => {
    const { db, account } = await twoOrgsWithAgents();
    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        accountId: account.id,
        url: "https://example.com/hook",
        secretCiphertext: "x",
        events: ["call.ended", "usage.recorded"],
      })
      .returning();
    const callId = crypto.randomUUID();
    await db.insert(webhookDeliveries).values([
      { endpointId: endpoint!.id, event: "call.ended", eventKey: callId, payload: {} },
      { endpointId: endpoint!.id, event: "usage.recorded", eventKey: callId, payload: {} },
    ]);
    expect(await db.$count(webhookDeliveries)).toBe(2);
  });
});
