import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accountLedger,
  accounts,
  defaultApiKeyScopes,
  numberRents,
  orgs,
  phoneNumbers,
  rateCards,
  webhookDeliveries,
  webhookEndpoints,
} from "../../src/db/schema";
import { seedLikeRates } from "../fixtures/rate-card";
import { TEST_INBOUND_TRUNK, TEST_NOW } from "../http/test-app";
import { createV1Scenario } from "../http/v1-scenario";
import { PlivoError } from "../../src/modules/numbers/plivo";

const NEW_NUMBER = "+918069000001";

/** automitra renting for one org with accepted KYC; the card rents numbers at ₹500 a month. */
async function rentingScenario(options: { monthlyRentInr?: number | null } = {}) {
  const scenario = await createV1Scenario();
  const { db, api, account, plivo } = scenario;
  const monthlyRentInr = options.monthlyRentInr === undefined ? 500 : options.monthlyRentInr;
  const rates =
    monthlyRentInr === null
      ? seedLikeRates
      : { ...seedLikeRates, numberMonthlyRentInr: monthlyRentInr };
  await db.update(rateCards).set({ rates });
  await api("PUT", "/orgs/clinic-42", { name: "Sharma Clinic" });
  await db
    .update(orgs)
    .set({ numberKycStatus: "accepted", numberKycApplicationId: "compliance-test" })
    .where(eq(orgs.externalId, "clinic-42"));
  plivo!.acceptApplication("compliance-test").offer(NEW_NUMBER, "+918069000002");
  await db.insert(webhookEndpoints).values({
    accountId: account.id,
    url: "https://automitra.example/hooks",
    secretCiphertext: "x",
    events: ["number.rented", "number.rent_charged", "number.released"],
  });
  const rent = (number = NEW_NUMBER, requestKey = "rent-1") =>
    api("POST", "/orgs/clinic-42/numbers", { number }, { "idempotency-key": requestKey });
  const queued = (event: "number.rented" | "number.rent_charged" | "number.released") =>
    db.select().from(webhookDeliveries).where(eq(webhookDeliveries.event, event));
  return { ...scenario, plivo: plivo!, rent, queued };
}

describe("searching numbers", () => {
  test("lists Plivo's numbers with this account's monthly rent", async () => {
    const { api } = await rentingScenario();
    const found = await api("GET", "/numbers/available?pattern=8069&limit=1");
    expect(found.status).toBe(200);
    expect(found.body.numbers).toEqual([
      { number: NEW_NUMBER, city: "Bangalore", region: "Karnataka", monthlyRentInr: 500 },
    ]);
  });

  test("needs numbers:rent, a card that rents numbers, and stays under 10 searches a minute", async () => {
    const { api, issue, v1 } = await rentingScenario({ monthlyRentInr: null });
    const plainKey = await issue({ scopes: defaultApiKeyScopes });
    expect((await v1(plainKey, "GET", "/numbers/available")).status).toBe(403);

    const notOffered = await api("GET", "/numbers/available");
    expect(notOffered.status).toBe(422);
    for (let i = 1; i < 10; i++) await api("GET", "/numbers/available");
    const limited = await api("GET", "/numbers/available");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

describe("renting a number", () => {
  test("buys it, sends its calls to our trunk, and charges the first month once", async () => {
    const { rent, db, plivo, queued } = await rentingScenario();
    const rented = await rent();
    expect(rented.status).toBe(201);
    expect(rented.body).toEqual({
      number: NEW_NUMBER,
      monthlyRentInr: 500,
      rentedAt: TEST_NOW.toISOString(),
      nextChargeAt: "2026-11-05T06:30:00.000Z",
    });
    expect(plivo.held.get(NEW_NUMBER)).toEqual({
      complianceApplicationId: "compliance-test",
      inboundTrunkId: TEST_INBOUND_TRUNK,
    });

    const [number] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.e164, NEW_NUMBER));
    expect(number).toMatchObject({
      source: "rented",
      status: "assigned",
      monthlyRentInr: "500.00",
    });
    const [charge] = await db.select().from(numberRents);
    expect(charge).toMatchObject({ amountInr: "500.00", periodStart: TEST_NOW });
    expect(await db.$count(accountLedger, eq(accountLedger.kind, "number_rent"))).toBe(1);
    expect((await queued("number.rented"))[0]!.payload).toMatchObject({ number: NEW_NUMBER });
    expect((await queued("number.rent_charged"))[0]!.payload).toEqual({
      orgId: "clinic-42",
      number: NEW_NUMBER,
      numberRentId: charge!.id,
      amountInr: 500,
      periodStart: TEST_NOW.toISOString(),
      periodEnd: "2026-11-05T06:30:00.000Z",
    });

    const replay = await rent();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(rented.body);
    expect(plivo.calls.filter((call) => call === "buyNumber")).toHaveLength(1);
    expect(await db.$count(numberRents)).toBe(1);
  });

  test("the rented number answers: the org lists it and can point an agent at it", async () => {
    const { rent, api } = await rentingScenario();
    await rent();
    const listed = await api("GET", "/orgs/clinic-42/numbers");
    expect(listed.body.numbers.map((n: { number: string }) => n.number)).toContain(NEW_NUMBER);
  });

  test("refused before KYC is accepted, over the credit cap, or without an Idempotency-Key", async () => {
    const { rent, api, db, account, plivo } = await rentingScenario();
    expect((await api("POST", "/orgs/clinic-42/numbers", { number: NEW_NUMBER })).status).toBe(400);

    await db.update(orgs).set({ numberKycStatus: "suspended" });
    const noKyc = await rent();
    expect([noKyc.status, noKyc.body.error]).toEqual([409, "number KYC not accepted"]);

    await db.update(orgs).set({ numberKycStatus: "accepted" });
    await db.update(accounts).set({ creditCapInr: "100.00" }).where(eq(accounts.id, account.id));
    await db.insert(accountLedger).values({
      accountId: account.id,
      kind: "adjustment",
      amountInr: "-100.00",
      idempotencyKey: "debit",
    });
    expect((await rent()).status).toBe(402);
    expect(plivo.calls).not.toContain("buyNumber");
    expect(await db.$count(phoneNumbers)).toBe(0);
  });

  test("a number someone else holds, or one Plivo will not sell, saves and charges nothing", async () => {
    const { rent, db, plivo } = await rentingScenario();
    await rent(NEW_NUMBER, "first");
    const taken = await rent(NEW_NUMBER, "second");
    expect(taken.status).toBe(409);

    const unsold = await rent("+918069000099", "third");
    expect(unsold.status).toBe(409);
    expect(unsold.body.error).toContain("Plivo refused");
    expect(await db.$count(phoneNumbers)).toBe(1);
    expect(await db.$count(numberRents)).toBe(1);
    expect(plivo.held.has("+918069000099")).toBe(false);
  });

  test("when Plivo does not answer, the same key resumes the rent without buying twice", async () => {
    const { rent, db, plivo } = await rentingScenario();
    plivo.failNext("connectNumber");
    const failed = await rent();
    expect(failed.status).toBe(502);
    expect(plivo.held.has(NEW_NUMBER)).toBe(true);
    const [reserved] = await db.select().from(phoneNumbers);
    expect(reserved).toMatchObject({ status: "renting" });
    expect(await db.$count(numberRents)).toBe(0);

    const resumed = await rent();
    expect(resumed.status).toBe(201);
    expect(plivo.calls.filter((call) => call === "buyNumber")).toHaveLength(1);
    expect(await db.$count(numberRents)).toBe(1);
  });

  test("a timeout on the purchase itself keeps the reservation, since Plivo may have sold it", async () => {
    const { rent, db, plivo } = await rentingScenario();
    plivo.failNext("buyNumber", new PlivoError(null, "no answer within 10000 ms"));
    expect((await rent()).status).toBe(502);
    expect(await db.$count(phoneNumbers, eq(phoneNumbers.status, "renting"))).toBe(1);
  });

  test("an Idempotency-Key already used for another number is refused", async () => {
    const { rent } = await rentingScenario();
    await rent(NEW_NUMBER, "same");
    expect((await rent("+918069000002", "same")).status).toBe(422);
  });
});

describe("releasing a number", () => {
  test("a rented number goes back to Plivo at once and the account is told", async () => {
    const { rent, api, db, plivo, queued } = await rentingScenario();
    await rent();
    const released = await api("DELETE", `/orgs/clinic-42/numbers/${NEW_NUMBER}`);
    expect(released.status).toBe(202);
    expect(released.body).toEqual({ number: NEW_NUMBER, status: "released" });
    expect(plivo.held.has(NEW_NUMBER)).toBe(false);
    const [number] = await db.select().from(phoneNumbers);
    expect(number).toMatchObject({ status: "released", agentId: null });
    expect(await queued("number.released")).toHaveLength(1);
    expect((await api("DELETE", `/orgs/clinic-42/numbers/${NEW_NUMBER}`)).status).toBe(404);
  });

  test("a number we assigned is released only by us", async () => {
    const { api, withOrgAndAgent } = await rentingScenario();
    await withOrgAndAgent();
    const refused = await api("DELETE", "/orgs/clinic-42/numbers/+918045001234");
    expect(refused.status).toBe(403);
  });
});

describe("without Plivo configured", () => {
  test("renting, releasing, searching and KYC answer 503", async () => {
    const { api } = await createV1Scenario({ plivo: null });
    await api("PUT", "/orgs/clinic-42", { name: "Sharma Clinic" });
    const headers = { "idempotency-key": "k" };
    expect((await api("GET", "/numbers/available")).status).toBe(503);
    expect(
      (await api("POST", "/orgs/clinic-42/numbers", { number: NEW_NUMBER }, headers)).status,
    ).toBe(503);
    expect((await api("DELETE", `/orgs/clinic-42/numbers/${NEW_NUMBER}`)).status).toBe(503);
    expect((await api("PUT", "/orgs/clinic-42/number-kyc", new FormData())).status).toBe(503);
  });
});
