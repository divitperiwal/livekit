import { describe, expect, test } from "bun:test";
import { orgs } from "../../src/db/schema";
import { CLINIC_NUMBER, createScenario, event } from "../http/scenario";

/** No cache exists yet, so every lookup is cold; the warm-cache half arrives with the cache. */
describe("guarantee 2: an orgId claim that does not own the agent gets 403", () => {
  async function scenarioWithAnotherOrg() {
    const scenario = await createScenario();
    const [other] = await scenario.db
      .insert(orgs)
      .values({ accountId: scenario.ids.accountId, externalId: "other-biz", name: "Other" })
      .returning();
    return { ...scenario, otherOrgId: other!.id };
  }

  test("on every resolution path", async () => {
    const { resolve, ids, otherOrgId } = await scenarioWithAnotherOrg();
    for (const query of [
      { agentVersionId: ids.agentVersionId },
      { agentId: ids.agentId },
      { number: CLINIC_NUMBER },
    ]) {
      expect((await resolve({ ...query, orgId: otherOrgId })).status).toBe(403);
      expect((await resolve({ ...query, orgId: ids.orgId })).status).toBe(200);
    }
  });

  test("an orgId that names no org is still a mismatch, not a filter", async () => {
    const { resolve, ids } = await createScenario();
    expect((await resolve({ agentId: ids.agentId, orgId: crypto.randomUUID() })).status).toBe(403);
  });

  test("opening a call for a version the org does not own", async () => {
    const { open, otherOrgId } = await scenarioWithAnotherOrg();
    expect((await open({ orgId: otherOrgId })).status).toBe(403);
  });

  test("writing events to another org's call", async () => {
    const { open, appendEvents, otherOrgId } = await scenarioWithAnotherOrg();
    const { body } = await open();
    expect((await appendEvents(body.id, [event(1)], otherOrgId)).status).toBe(403);
  });
});
