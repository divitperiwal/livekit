import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { orgs, suppressedNumbers } from "../../src/db/schema";
import { createV1Scenario } from "../http/v1-scenario";

describe("guarantee 13: the do-not-call list is checked at dial time", () => {
  test("a number the caller asked us not to call is refused, and nothing is dispatched", async () => {
    const { api, db, dispatches, withOrgAndAgent } = await createV1Scenario();
    const { org, agentId } = await withOrgAndAgent();
    await db
      .insert(suppressedNumbers)
      .values({ orgId: org.id, e164: "+919876543210", source: "caller_request" });

    const refused = await api("POST", "/orgs/clinic-42/calls", { agentId, to: "+919876543210" });
    expect(refused).toMatchObject({
      status: 422,
      body: { error: "the number is on the org's do-not-call list" },
    });
    expect(dispatches).toHaveLength(0);
    expect(
      (await api("POST", "/orgs/clinic-42/calls", { agentId, to: "+919876543211" })).status,
    ).toBe(202);
  });

  test("the list is per org", async () => {
    const { api, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    await api("PUT", "/orgs/other", { name: "Other" });
    const [other] = await db.select().from(orgs).where(eq(orgs.externalId, "other"));
    await db
      .insert(suppressedNumbers)
      .values({ orgId: other!.id, e164: "+919876543210", source: "api" });
    expect(
      (await api("POST", "/orgs/clinic-42/calls", { agentId, to: "+919876543210" })).status,
    ).toBe(202);
  });
});
