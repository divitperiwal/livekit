import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accountLedger,
  agents,
  billingWebhookEvents,
  calls,
  numberRents,
  orgs,
  phoneNumbers,
  webhookDeliveries,
  webhookEndpoints,
} from "../../src/db/schema";
import { seedAccount, seedAgentWithVersion, seedOrg, seedRentedNumber } from "./seed";
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

describe("phone numbers", () => {
  test("a released number can be bought again, but a number is held only once", async () => {
    const { db, account, orgA, orgB } = await twoOrgsWithAgents();
    const { number } = await seedRentedNumber(db, { accountId: account.id, orgId: orgA.id }, "500");
    await db
      .update(phoneNumbers)
      .set({ status: "released", releasedAt: new Date() })
      .where(eq(phoneNumbers.id, number.id));
    await seedRentedNumber(db, { accountId: account.id, orgId: orgB.id }, "500");

    const error = await postgresError(
      db.insert(phoneNumbers).values({ e164: number.e164, status: "available" }),
    );
    expect(error.constraint).toBe("phone_numbers_e164_held_key");
  });

  test("a rented number carries its monthly rent", async () => {
    const { db, orgA } = await twoOrgsWithAgents();
    const error = await postgresError(
      db.insert(phoneNumbers).values({
        e164: "+918069000009",
        orgId: orgA.id,
        source: "rented",
        status: "assigned",
        rentedAt: new Date(),
      }),
    );
    expect(error.constraint).toBe("phone_numbers_rented_has_rent");
  });

  test("only a pool number is available, and only it has no org", async () => {
    const { db, orgA } = await twoOrgsWithAgents();
    const assignedWithoutOrg = await postgresError(
      db.insert(phoneNumbers).values({ e164: "+918069000010", status: "assigned" }),
    );
    expect(assignedWithoutOrg.constraint).toBe("phone_numbers_held_has_org");
    const availableWithOrg = await postgresError(
      db.insert(phoneNumbers).values({ e164: "+918069000011", orgId: orgA.id }),
    );
    expect(availableWithOrg.constraint).toBe("phone_numbers_available_has_no_org");
  });
});

describe("number rent", () => {
  test("a number is charged once per period", async () => {
    const { db, account, orgA } = await twoOrgsWithAgents();
    const { rent } = await seedRentedNumber(db, { accountId: account.id, orgId: orgA.id }, "500");
    const error = await postgresError(
      db.insert(numberRents).values({ ...rent, id: undefined, createdAt: undefined }),
    );
    expect(error.constraint).toBe("number_rents_number_period_key");
  });

  test("a rent ledger entry must name the rent it charges", async () => {
    const { db, account } = await twoOrgsWithAgents();
    const error = await postgresError(
      db.insert(accountLedger).values({
        accountId: account.id,
        kind: "number_rent",
        amountInr: "500",
        idempotencyKey: "rent-without-row",
      }),
    );
    expect(error.constraint).toBe("account_ledger_number_rent_links_rent");
  });
});

describe("number KYC", () => {
  test("a submitted application has Plivo's id, and a rejection has its reason", async () => {
    const { db, orgA } = await twoOrgsWithAgents();
    const withoutApplication = await postgresError(
      db.update(orgs).set({ numberKycStatus: "submitted" }).where(eq(orgs.id, orgA.id)),
    );
    expect(withoutApplication.constraint).toBe("orgs_number_kyc_has_application");
    const withoutReason = await postgresError(
      db
        .update(orgs)
        .set({ numberKycStatus: "rejected", numberKycApplicationId: "app-1" })
        .where(eq(orgs.id, orgA.id)),
    );
    expect(withoutReason.constraint).toBe("orgs_number_kyc_rejection_has_reason");
  });
});

describe("webhook deliveries", () => {
  test.each([...billingWebhookEvents])("%s can never be marked failed", async (event) => {
    const { db, account } = await twoOrgsWithAgents();
    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        accountId: account.id,
        url: "https://example.com/hook",
        secretCiphertext: "x",
        events: [event],
      })
      .returning();
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: endpoint!.id, event, eventKey: "key-1", payload: {} })
      .returning();
    const error = await postgresError(
      db
        .update(webhookDeliveries)
        .set({ status: "failed" })
        .where(eq(webhookDeliveries.id, delivery!.id)),
    );
    expect(error.constraint).toBe("webhook_deliveries_billing_never_fails");
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
