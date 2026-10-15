import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts, agentVersions, orgs, phoneNumbers } from "../../src/db/schema";
import { testSecretBox } from "../fixtures/secrets";
import { CLINIC_NUMBER } from "../http/scenario";
import { agentBody, createV1Scenario, ORG_NUMBER } from "../http/v1-scenario";
import { TEST_INTERNAL_SECRET } from "../http/test-app";

describe("orgs", () => {
  test("PUT creates on first sight of the id, then updates", async () => {
    const { api } = await createV1Scenario();
    const created = await api("PUT", "/orgs/clinic-42", { name: "Sharma Clinic" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "clinic-42",
      name: "Sharma Clinic",
      recordCalls: false,
      redactPii: false,
    });
    const updated = await api("PUT", "/orgs/clinic-42", {
      name: "Sharma Clinic",
      recordCalls: true,
    });
    expect(updated).toMatchObject({ status: 200, body: { recordCalls: true } });
    expect((await api("GET", "/orgs")).body.orgs.map((org: { id: string }) => org.id)).toEqual([
      "clinic-42",
    ]);
  });

  test("rejects unknown fields and bad ids", async () => {
    const { api } = await createV1Scenario();
    expect((await api("PUT", "/orgs/clinic-42", { name: "x", plan: "growth" })).status).toBe(400);
    expect((await api("PUT", "/orgs/has space", { name: "x" })).status).toBe(400);
  });

  test("deleting waits until its numbers are released, then archives agents and retires the id", async () => {
    const { api, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const refused = await api("DELETE", "/orgs/clinic-42");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`release the org's numbers first: ${ORG_NUMBER}`);

    await db
      .update(phoneNumbers)
      .set({ status: "released", agentId: null, releasedAt: new Date() })
      .where(eq(phoneNumbers.e164, ORG_NUMBER));
    expect((await api("DELETE", "/orgs/clinic-42")).status).toBe(204);
    expect((await api("GET", "/orgs/clinic-42")).status).toBe(404);
    expect((await api("GET", `/orgs/clinic-42/agents/${agentId}`)).status).toBe(404);
    expect((await api("PUT", "/orgs/clinic-42", { name: "again" })).status).toBe(409);
  });
});

describe("agents and versions", () => {
  test("a new agent has a draft and answers nothing until published", async () => {
    const { api, app, db } = await createV1Scenario();
    await api("PUT", "/orgs/clinic-42", { name: "Sharma Clinic" });
    await db
      .update(orgs)
      .set({ numberKycStatus: "accepted", numberKycApplicationId: "compliance-test" })
      .where(eq(orgs.externalId, "clinic-42"));
    const created = await api("POST", "/orgs/clinic-42/agents", agentBody);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "receptionist", liveVersionId: null });
    expect(created.body.draftVersionId).toBeString();

    const resolve = (agentId: string) =>
      app.request(`/internal/resolve?agentId=${agentId}`, {
        headers: { "x-internal-secret": TEST_INTERNAL_SECRET },
      });
    expect((await resolve(created.body.id)).status).toBe(404);

    const published = await api("POST", `/orgs/clinic-42/agents/${created.body.id}/publish`, {});
    expect(published.body.liveVersionId).toBe(created.body.draftVersionId);
    expect((await resolve(created.body.id)).status).toBe(200);
  });

  test("an invalid config is refused with the worker's reasons", async () => {
    const { api } = await createV1Scenario();
    await api("PUT", "/orgs/clinic-42", { name: "Sharma Clinic" });
    const refused = await api("POST", "/orgs/clinic-42/agents", {
      ...agentBody,
      config: { ttsSpeaker: "nobody", ttsPace: 9 },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("ttsPace");
  });

  test("saving a draft writes a new version; live stays until published", async () => {
    const { api, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const before = (await api("GET", `/orgs/clinic-42/agents/${agentId}`)).body;
    const saved = await api("PUT", `/orgs/clinic-42/agents/${agentId}/draft`, {
      ...agentBody,
      name: undefined,
      slug: undefined,
      greeting: "Hello!",
    });
    expect(saved.status).toBe(201);
    expect(saved.body.version.version).toBe(2);
    expect(saved.body.agent.liveVersionId).toBe(before.liveVersionId);
    expect(saved.body.agent.draftVersionId).toBe(saved.body.version.id);
    const [first] = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.id, before.liveVersionId));
    expect(first!.greeting).toBe("Namaste, Sharma Clinic.");
    expect(
      (await api("GET", `/orgs/clinic-42/agents/${agentId}/versions`)).body.versions.map(
        (v: { version: number }) => v.version,
      ),
    ).toEqual([2, 1]);
  });

  test("an experiment sends a share of calls to a candidate, and publishing it ends the experiment", async () => {
    const { api, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const draft = (
      await api("PUT", `/orgs/clinic-42/agents/${agentId}/draft`, {
        instructions: "v2",
        greeting: "Hi",
      })
    ).body.version;
    const experiment = await api("PUT", `/orgs/clinic-42/agents/${agentId}/experiment`, {
      versionId: draft.id,
      percent: 10,
    });
    expect(experiment.body).toMatchObject({ candidateVersionId: draft.id, candidatePercent: 10 });
    const published = await api("POST", `/orgs/clinic-42/agents/${agentId}/publish`, {
      versionId: draft.id,
    });
    expect(published.body).toMatchObject({
      liveVersionId: draft.id,
      candidateVersionId: null,
      candidatePercent: 0,
    });
  });

  test("a duplicate slug conflicts; archiving unhooks its numbers", async () => {
    const { api, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    expect((await api("POST", "/orgs/clinic-42/agents", agentBody)).status).toBe(409);
    expect((await api("DELETE", `/orgs/clinic-42/agents/${agentId}`)).body.status).toBe("archived");
    const [number] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.e164, ORG_NUMBER));
    expect(number?.agentId).toBeNull();
    expect(
      (
        await api("PUT", `/orgs/clinic-42/agents/${agentId}/draft`, {
          instructions: "x",
          greeting: "y",
        })
      ).status,
    ).toBe(409);
  });

  test("customer tools are saved only once the account can sign their requests", async () => {
    const { api, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    const withTools = {
      ...agentBody,
      name: undefined,
      slug: undefined,
      config: {
        httpTools: [
          { name: "check_stock", description: "Pigs in stock.", url: "https://erp.example.in/s" },
        ],
      },
    };
    const refused = await api("PUT", `/orgs/clinic-42/agents/${agentId}/draft`, withTools);
    expect(refused).toMatchObject({
      status: 422,
      body: {
        error:
          "invalid config: httpTools need the account's tool signing secret: ask us to set one",
      },
    });
    const newAgent = { ...agentBody, slug: "stock-desk", config: withTools.config };
    expect((await api("POST", "/orgs/clinic-42/agents", newAgent)).status).toBe(422);

    await db.update(accounts).set({ toolSecretCiphertext: testSecretBox.encrypt("tsec_x") });
    expect((await api("PUT", `/orgs/clinic-42/agents/${agentId}/draft`, withTools)).status).toBe(
      201,
    );
    expect((await api("POST", "/orgs/clinic-42/agents", newAgent)).status).toBe(201);
  });
});

describe("an org's numbers", () => {
  test("point a number at an agent, or at none", async () => {
    const { api, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    expect((await api("GET", "/orgs/clinic-42/numbers")).body.numbers).toEqual([
      { number: ORG_NUMBER, direction: "both", agentId },
    ]);
    expect(
      (
        await api("PUT", `/orgs/clinic-42/numbers/${encodeURIComponent(ORG_NUMBER)}`, {
          agentId: null,
        })
      ).status,
    ).toBe(200);
    expect((await api("GET", "/orgs/clinic-42/numbers")).body.numbers[0].agentId).toBeNull();
    expect(
      (
        await api(
          "PUT",
          `/orgs/clinic-42/numbers/${encodeURIComponent(CLINIC_NUMBER.replace("4", "9"))}`,
          { agentId },
        )
      ).status,
    ).toBe(404);
  });
});
