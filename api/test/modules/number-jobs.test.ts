import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accountLedger,
  numberRents,
  orgs,
  phoneNumbers,
  webhookDeliveries,
  webhookEndpoints,
} from "../../src/db/schema";
import { backgroundJobs } from "../../src/jobs/jobs";
import { chargeMonthlyRent } from "../../src/modules/numbers/monthly-rent";
import { pollNumberKyc } from "../../src/modules/numbers/number-kyc";
import { retryPendingReleases } from "../../src/modules/numbers/release-number";
import { undoAbandonedRents } from "../../src/modules/numbers/rent-number";
import { seedAccount, seedOrg, seedRentedNumber } from "../db/seed";
import { createTestDatabase } from "../db/test-database";
import { FakePlivo } from "../fixtures/fake-plivo";
import { testSecretBox } from "../fixtures/secrets";

const RENTED = "+918069000001";
/** seedRentedNumber rents on 1 Oct 2026 05:30 IST and charges the first month. */
const SECOND_MONTH = new Date("2026-11-01T00:00:00Z");

async function rentedNumberScenario() {
  const { db } = await createTestDatabase();
  const account = await seedAccount(db);
  const org = await seedOrg(db, account.id, "clinic-1");
  await db
    .update(orgs)
    .set({ numberKycStatus: "accepted", numberKycApplicationId: "compliance-1" })
    .where(eq(orgs.id, org.id));
  await db.insert(webhookEndpoints).values({
    accountId: account.id,
    url: "https://automitra.example/hooks",
    secretCiphertext: "x",
    events: ["number.rent_charged", "number.released", "number_kyc.updated"],
  });
  const { number } = await seedRentedNumber(
    db,
    { accountId: account.id, orgId: org.id },
    "500",
    RENTED,
  );
  const plivo = new FakePlivo().holdManaged(RENTED).acceptApplication("compliance-1");
  const at = (now: Date) => ({ db, plivo, now: () => now });
  const events = (event: "number.rent_charged" | "number.released" | "number_kyc.updated") =>
    db.select().from(webhookDeliveries).where(eq(webhookDeliveries.event, event));
  return { db, account, org, number, plivo, at, events };
}

describe("monthly rent", () => {
  test("nothing is due inside a paid month", async () => {
    const { at } = await rentedNumberScenario();
    const result = await chargeMonthlyRent(at(new Date(SECOND_MONTH.getTime() - 1)));
    expect(result).toEqual({ charged: 0, released: 0, releasePending: 0 });
  });

  test("the next month is charged upfront on the anniversary, once", async () => {
    const { db, at, events } = await rentedNumberScenario();
    expect((await chargeMonthlyRent(at(SECOND_MONTH))).charged).toBe(1);
    expect((await chargeMonthlyRent(at(SECOND_MONTH))).charged).toBe(0);

    const rents = await db.select().from(numberRents).orderBy(numberRents.periodStart);
    expect(rents.map((rent) => [rent.periodStart, rent.periodEnd])).toEqual([
      [new Date("2026-10-01T00:00:00Z"), SECOND_MONTH],
      [SECOND_MONTH, new Date("2026-12-01T00:00:00Z")],
    ]);
    expect(await db.$count(accountLedger, eq(accountLedger.kind, "number_rent"))).toBe(2);
    const [charged] = await events("number.rent_charged");
    expect(charged!.payload).toMatchObject({
      number: RENTED,
      amountInr: 500,
      periodStart: SECOND_MONTH.toISOString(),
    });
  });

  test("a missed run catches up every month owed, from the rent date", async () => {
    const { db, at } = await rentedNumberScenario();
    expect((await chargeMonthlyRent(at(new Date("2027-01-15T00:00:00Z")))).charged).toBe(3);
    const starts = (await db.select().from(numberRents).orderBy(numberRents.periodStart)).map(
      (rent) => rent.periodStart.toISOString(),
    );
    expect(starts).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
  });

  test("a business whose KYC lapsed keeps its number until renewal, then loses it", async () => {
    const { db, number, plivo, at, events } = await rentedNumberScenario();
    await db.update(orgs).set({ numberKycStatus: "suspended" });

    await chargeMonthlyRent(at(new Date(SECOND_MONTH.getTime() - 1)));
    expect(plivo.held.has(RENTED)).toBe(true);

    const result = await chargeMonthlyRent(at(SECOND_MONTH));
    expect(result).toEqual({ charged: 0, released: 1, releasePending: 0 });
    expect(plivo.held.has(RENTED)).toBe(false);
    const [released] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, number.id));
    expect(released).toMatchObject({ status: "released" });
    expect(await db.$count(numberRents)).toBe(1);
    expect(await events("number.released")).toHaveLength(1);
  });

  test("numbers we assigned are billed outside voiceAi and never charged here", async () => {
    const { db, org, at } = await rentedNumberScenario();
    await db
      .insert(phoneNumbers)
      .values({ e164: "+918045001234", orgId: org.id, status: "assigned" });
    expect((await chargeMonthlyRent(at(SECOND_MONTH))).charged).toBe(1);
  });
});

describe("releases Plivo did not confirm", () => {
  test("are retried, and page someone after an hour", async () => {
    const { db, number, plivo, at } = await rentedNumberScenario();
    const since = new Date("2026-11-01T00:00:00Z");
    await db
      .update(phoneNumbers)
      .set({ status: "releasing", agentId: null, updatedAt: since })
      .where(eq(phoneNumbers.id, number.id));

    plivo.failNext("releaseNumber");
    expect(await retryPendingReleases(at(new Date(since.getTime() + 61 * 60_000)))).toEqual({
      released: 0,
      pending: 1,
      stuck: 1,
    });
    expect(await retryPendingReleases(at(since))).toEqual({ released: 1, pending: 0, stuck: 0 });
    expect(plivo.held.has(RENTED)).toBe(false);
  });
});

describe("rents left half-way", () => {
  async function withReservation(createdAt: Date) {
    const scenario = await rentedNumberScenario();
    await scenario.db.insert(phoneNumbers).values({
      e164: "+918069000002",
      orgId: scenario.org.id,
      source: "rented",
      status: "renting",
      monthlyRentInr: "500",
      rentRequestKey: "abandoned",
      createdAt,
    });
    return scenario;
  }
  const createdAt = new Date("2026-10-05T06:00:00Z");

  test("are undone after 15 minutes: a bought number goes back and nothing is charged", async () => {
    const { db, plivo, at } = await withReservation(createdAt);
    plivo.holdManaged("+918069000002");

    const early = await undoAbandonedRents(at(new Date(createdAt.getTime() + 14 * 60_000)));
    expect(early).toEqual({ undone: 0, pending: 0 });

    const late = await undoAbandonedRents(at(new Date(createdAt.getTime() + 16 * 60_000)));
    expect(late).toEqual({ undone: 1, pending: 0 });
    expect(plivo.held.has("+918069000002")).toBe(false);
    expect(await db.$count(phoneNumbers, eq(phoneNumbers.status, "renting"))).toBe(0);
    expect(await db.$count(numberRents)).toBe(1);
  });

  test("stay for the next pass when Plivo does not answer", async () => {
    const { db, plivo, at } = await withReservation(createdAt);
    plivo.holdManaged("+918069000002").failNext("releaseNumber");
    const result = await undoAbandonedRents(at(new Date(createdAt.getTime() + 16 * 60_000)));
    expect(result).toEqual({ undone: 0, pending: 1 });
    expect(await db.$count(phoneNumbers, eq(phoneNumbers.status, "renting"))).toBe(1);
  });
});

describe("the KYC poll", () => {
  test("notices a suspension Plivo never called back about, and tells the account", async () => {
    const { db, plivo, at, events } = await rentedNumberScenario();
    plivo.decideKyc("compliance-1", "suspended");
    const result = await pollNumberKyc(at(SECOND_MONTH), ["accepted"]);
    expect(result).toEqual({ checked: 1, changed: 1, failed: 0 });
    const [org] = await db.select().from(orgs);
    expect(org!.numberKycStatus).toBe("suspended");
    expect((await events("number_kyc.updated"))[0]!.payload).toMatchObject({
      status: "suspended",
    });
  });

  test("skips deleted orgs and counts Plivo failures without stopping", async () => {
    const { db, account, at } = await rentedNumberScenario();
    const other = await seedOrg(db, account.id, "clinic-2");
    await db
      .update(orgs)
      .set({ numberKycStatus: "submitted", numberKycApplicationId: "compliance-9" })
      .where(eq(orgs.id, other.id));
    const deleted = await seedOrg(db, account.id, "clinic-3");
    await db
      .update(orgs)
      .set({
        numberKycStatus: "submitted",
        numberKycApplicationId: "compliance-1",
        deletedAt: SECOND_MONTH,
      })
      .where(eq(orgs.id, deleted.id));

    // Plivo has no application compliance-9, so asking about it fails.
    const result = await pollNumberKyc(at(SECOND_MONTH), ["submitted"]);
    expect(result).toEqual({ checked: 0, changed: 0, failed: 1 });
  });
});

describe("the background process", () => {
  test("runs the number jobs only when Plivo is configured", async () => {
    const { db } = await createTestDatabase();
    const base = {
      db,
      secretBox: testSecretBox,
      deleteRecording: async () => {},
      maxCallSeconds: 600,
    };
    const without = backgroundJobs({ ...base, plivo: null }).map((job) => job.name);
    const withPlivo = backgroundJobs({ ...base, plivo: new FakePlivo() }).map((job) => job.name);
    expect(without).not.toContain("monthly-number-rent");
    expect(withPlivo).toEqual([
      ...without,
      "monthly-number-rent",
      "number-releases",
      "abandoned-rents",
      "kyc-poll-pending",
      "kyc-poll-accepted",
      "ucc-complaints",
    ]);
  });

  test("an undelivered number.rent_charged pages someone after 15 minutes", async () => {
    const { db, at, events } = await rentedNumberScenario();
    await chargeMonthlyRent(at(SECOND_MONTH));
    expect(await events("number.rent_charged")).toHaveLength(1);
    const lines: string[] = [];
    const watch = backgroundJobs({
      db,
      secretBox: testSecretBox,
      deleteRecording: async () => {},
      maxCallSeconds: 600,
      plivo: null,
      now: () => new Date(Date.now() + 16 * 60_000),
      log: (line) => lines.push(line),
    }).find((job) => job.name === "billing-delivery-watch")!;
    await watch.run();
    expect(lines.some((line) => line.startsWith("ALERT rent-undelivered"))).toBe(true);
  });
});
