import { describe, expect, test } from "bun:test";
import { accountLedger, orgs } from "../../src/db/schema";
import { CLINIC_NUMBER, createScenario } from "../http/scenario";
import { testSecretBox } from "../fixtures/secrets";
import { eq } from "drizzle-orm";

const balanceUrl = {
  balanceCheckUrl: "https://automitra.example/balance",
  balanceCheckSecretCiphertext: testSecretBox.encrypt("s3cret"),
};

/** API half: every resolution path refuses with 402, so the agent never speaks. */
describe("guarantee 3: an org with no credit gets 402 on every resolution path", () => {
  async function everyPath(scenario: Awaited<ReturnType<typeof createScenario>>) {
    const { resolve, ids } = scenario;
    return Promise.all(
      [
        { agentVersionId: ids.agentVersionId },
        { agentId: ids.agentId },
        { number: CLINIC_NUMBER },
      ].map(async (query) => (await resolve(query)).status),
    );
  }

  test("a suspended account", async () => {
    expect(await everyPath(await createScenario({ account: { status: "suspended" } }))).toEqual([
      402, 402, 402,
    ]);
  });

  test("a postpaid account at its credit cap", async () => {
    const scenario = await createScenario({ account: { creditCapInr: "10.00" } });
    await scenario.db.insert(accountLedger).values({
      accountId: scenario.ids.accountId,
      kind: "adjustment",
      amountInr: "-10.00",
      idempotencyKey: "debit-1",
    });
    expect(await everyPath(scenario)).toEqual([402, 402, 402]);
  });

  test("an org whose balance URL says 0", async () => {
    const scenario = await createScenario({
      account: balanceUrl,
      balance: () => Response.json({ availableInr: 0 }),
    });
    expect(await everyPath(scenario)).toEqual([402, 402, 402]);
  });

  test("a suspended org", async () => {
    const scenario = await createScenario();
    await scenario.db
      .update(orgs)
      .set({ status: "suspended" })
      .where(eq(orgs.id, scenario.ids.orgId));
    expect(await everyPath(scenario)).toEqual([402, 402, 402]);
  });

  test("an org with a balance gets through, its budget capped to it", async () => {
    const scenario = await createScenario({
      account: balanceUrl,
      balance: () => Response.json({ availableInr: 40 }),
    });
    expect((await scenario.resolve({ number: CLINIC_NUMBER })).body.availableInr).toBe(40);
  });
});
