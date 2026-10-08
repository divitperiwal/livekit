import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, orgs, phoneNumbers } from "../../src/db/schema";
import { CLINIC_NUMBER, createScenario } from "../http/scenario";

/** API half: anything that cannot be resolved gets a refusal, never a fallback configuration. */
describe("guarantee 1: a call that cannot be resolved is never given a fallback", () => {
  test("an unknown number, agent or version is 404", async () => {
    const { resolve } = await createScenario();
    for (const query of [
      { number: "+911111111111" },
      { agentId: crypto.randomUUID() },
      { agentVersionId: crypto.randomUUID() },
      { agentId: "not-a-uuid" },
    ]) {
      expect((await resolve(query)).status).toBe(404);
    }
  });

  test("an agent with no live version is 404", async () => {
    const { resolve, db, ids } = await createScenario();
    await db.update(agents).set({ liveVersionId: null }).where(eq(agents.id, ids.agentId));
    expect((await resolve({ agentId: ids.agentId })).status).toBe(404);
    expect((await resolve({ number: CLINIC_NUMBER })).status).toBe(404);
  });

  test("an archived agent, a deleted org or a released number is 404", async () => {
    const archived = await createScenario();
    await archived.db
      .update(agents)
      .set({ status: "archived" })
      .where(eq(agents.id, archived.ids.agentId));
    expect((await archived.resolve({ number: CLINIC_NUMBER })).status).toBe(404);

    const deleted = await createScenario();
    await deleted.db
      .update(orgs)
      .set({ deletedAt: new Date() })
      .where(eq(orgs.id, deleted.ids.orgId));
    expect((await deleted.resolve({ number: CLINIC_NUMBER })).status).toBe(404);

    const released = await createScenario();
    await released.db
      .update(phoneNumbers)
      .set({ status: "releasing" })
      .where(eq(phoneNumbers.id, released.ids.phoneNumberId));
    expect((await released.resolve({ number: CLINIC_NUMBER })).status).toBe(404);
  });
});
