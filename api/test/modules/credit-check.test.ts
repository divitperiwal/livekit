import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accountLedger, accounts } from "../../src/db/schema";
import { BalanceChecker } from "../../src/modules/billing/balance-check";
import { checkCredit } from "../../src/modules/billing/credit-check";
import { seedAccount, seedAgentWithVersion, seedCallWithUsage, seedOrg } from "../db/seed";
import { createTestDatabase } from "../db/test-database";
import { testSecretBox } from "../fixtures/secrets";

type AccountSettings = Partial<typeof accounts.$inferInsert>;

async function accountWithOneOrg(
  settings: AccountSettings = {},
  balance: () => Response = () => Response.json({}),
) {
  const { db } = await createTestDatabase();
  const account = await seedAccount(db);
  if (Object.keys(settings).length > 0) {
    await db.update(accounts).set(settings).where(eq(accounts.id, account.id));
  }
  const org = await seedOrg(db, account.id);
  const { agent, version } = await seedAgentWithVersion(db, org.id);
  const fakeFetch = async () => balance();
  const balanceChecker = new BalanceChecker({
    fetch: fakeFetch as unknown as typeof fetch,
    onFailure: () => {},
  });

  const check = () =>
    checkCredit({ db, balanceChecker, secretBox: testSecretBox }, account.id, org.externalId);
  const charge = (priceInr: string) =>
    seedCallWithUsage(
      db,
      { accountId: account.id, orgId: org.id, agentId: agent.id, agentVersionId: version.id },
      priceInr,
    );
  const pay = (amountInr: string) =>
    db.insert(accountLedger).values({
      accountId: account.id,
      kind: "payment",
      amountInr,
      idempotencyKey: crypto.randomUUID(),
    });
  return { check, charge, pay };
}

const withBalanceUrl: AccountSettings = {
  balanceCheckUrl: "https://automitra.example/balance",
  balanceCheckSecretCiphertext: testSecretBox.encrypt("s3cret"),
};

describe("the credit check", () => {
  test("an active account with no limits may call, with no limit on the budget", async () => {
    const { check } = await accountWithOneOrg();
    expect(await check()).toEqual({ allowed: true, availableInr: null });
  });

  test("a suspended account may not call", async () => {
    const { check } = await accountWithOneOrg({ status: "suspended" });
    expect(await check()).toEqual({ allowed: false, reason: "account suspended" });
  });

  test("postpaid: the budget is what the cap leaves, and the cap refuses once reached", async () => {
    const { check, charge } = await accountWithOneOrg({ creditCapInr: "100.00" });
    await charge("60.00");
    expect(await check()).toEqual({ allowed: true, availableInr: 40 });
    await charge("40.00");
    expect(await check()).toEqual({ allowed: false, reason: "credit cap reached" });
  });

  test("postpaid: a recorded payment lifts the cap", async () => {
    const { check, charge, pay } = await accountWithOneOrg({ creditCapInr: "100.00" });
    await charge("100.00");
    await pay("50.00");
    expect(await check()).toEqual({ allowed: true, availableInr: 50 });
  });

  test("the daily cap refuses once today's usage reaches it", async () => {
    const { check, charge } = await accountWithOneOrg({
      creditCapInr: "1000.00",
      dailyCapInr: "50.00",
    });
    await charge("20.00");
    expect(await check()).toEqual({ allowed: true, availableInr: 30 });
    await charge("30.00");
    expect(await check()).toEqual({ allowed: false, reason: "daily cap reached" });
  });

  test("the balance URL's answer caps the budget, and 0 or less refuses", async () => {
    const funded = await accountWithOneOrg(withBalanceUrl, () =>
      Response.json({ availableInr: 75 }),
    );
    expect(await funded.check()).toEqual({ allowed: true, availableInr: 75 });
    const empty = await accountWithOneOrg(withBalanceUrl, () => Response.json({ availableInr: 0 }));
    expect(await empty.check()).toEqual({ allowed: false, reason: "no balance" });
  });

  test("a balance URL that does not answer allows the call (fail open)", async () => {
    const { check } = await accountWithOneOrg(
      withBalanceUrl,
      () => new Response("down", { status: 500 }),
    );
    expect(await check()).toEqual({ allowed: true, availableInr: null });
  });

  test("the tightest limit wins", async () => {
    const { check } = await accountWithOneOrg({ ...withBalanceUrl, creditCapInr: "500.00" }, () =>
      Response.json({ availableInr: 12.5 }),
    );
    expect(await check()).toEqual({ allowed: true, availableInr: 12.5 });
  });
});
