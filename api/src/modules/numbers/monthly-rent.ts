import { and, count, eq } from "drizzle-orm";
import type { Database } from "../../db/database";
import { accountLedger, numberRents, orgs, phoneNumbers } from "../../db/schema";
import { addIndianMonths } from "../time/india";
import { enqueueWebhook } from "../webhooks/enqueue";
import type { Plivo } from "./plivo";
import { releaseHeldNumber } from "./release-number";
import { numberRentPayload } from "./rent-number";

export type MonthlyRentDependencies = { db: Database; plivo: Plivo; now?: () => Date };
export type MonthlyRentResult = { charged: number; released: number; releasePending: number };

type DueNumber = {
  number: typeof phoneNumbers.$inferSelect;
  org: typeof orgs.$inferSelect;
  periodsCharged: number;
};

/**
 * Charges every rented number whose paid month has ended, upfront for the next month,
 * and sends `number.rent_charged`. Renewals charge even over the credit cap. A business
 * whose KYC is no longer accepted on its renewal date loses the number instead. Months
 * are counted from the rent date, so a missed run catches up and nothing is charged twice.
 * Numbers we assigned (managed accounts) are billed outside voiceAi and never charged here.
 */
export async function chargeMonthlyRent(deps: MonthlyRentDependencies): Promise<MonthlyRentResult> {
  const now = deps.now?.() ?? new Date();
  const result: MonthlyRentResult = { charged: 0, released: 0, releasePending: 0 };
  for (const due of await rentedNumbersDue(deps.db, now)) {
    if (due.org.numberKycStatus !== "accepted") {
      const outcome = await releaseHeldNumber(deps, due.number.e164);
      if (outcome.kind === "released") result.released += 1;
      if (outcome.kind === "pending") result.releasePending += 1;
      continue;
    }
    result.charged += await chargeOwedMonths(deps.db, due, now);
  }
  return result;
}

async function rentedNumbersDue(db: Database, now: Date): Promise<DueNumber[]> {
  const rented = await db
    .select({ number: phoneNumbers, org: orgs, periodsCharged: count(numberRents.id) })
    .from(phoneNumbers)
    .innerJoin(orgs, eq(orgs.id, phoneNumbers.orgId))
    .leftJoin(numberRents, eq(numberRents.phoneNumberId, phoneNumbers.id))
    .where(and(eq(phoneNumbers.source, "rented"), eq(phoneNumbers.status, "assigned")))
    .groupBy(phoneNumbers.id, orgs.id);
  return rented.filter((row) => periodStart(row, row.periodsCharged) <= now);
}

function periodStart(due: Pick<DueNumber, "number">, index: number): Date {
  if (due.number.rentedAt === null || due.number.monthlyRentInr === null) {
    throw new Error(`rented number ${due.number.id} has no rent date or rent`);
  }
  return addIndianMonths(due.number.rentedAt, index);
}

/** One charge per month that has started; returns how many were new. */
async function chargeOwedMonths(db: Database, due: DueNumber, now: Date): Promise<number> {
  let charged = 0;
  for (let index = due.periodsCharged; periodStart(due, index) <= now; index++) {
    if (await chargeMonth(db, due, index)) charged += 1;
  }
  return charged;
}

async function chargeMonth(db: Database, due: DueNumber, index: number): Promise<boolean> {
  const { number, org } = due;
  return db.transaction(async (tx): Promise<boolean> => {
    const [rent] = await tx
      .insert(numberRents)
      .values({
        accountId: org.accountId,
        orgId: org.id,
        phoneNumberId: number.id,
        periodStart: periodStart(due, index),
        periodEnd: periodStart(due, index + 1),
        amountInr: String(number.monthlyRentInr),
      })
      .onConflictDoNothing()
      .returning();
    if (!rent) return false;
    await tx.insert(accountLedger).values({
      accountId: org.accountId,
      kind: "number_rent",
      amountInr: rent.amountInr,
      numberRentId: rent.id,
      idempotencyKey: `number_rent:${rent.id}`,
      description: `${number.e164} ${rent.periodStart.toISOString()}`,
    });
    await enqueueWebhook(tx, {
      accountId: org.accountId,
      orgId: org.id,
      type: "number.rent_charged",
      key: rent.id,
      payload: numberRentPayload(org.externalId, number.e164, rent),
    });
    return true;
  });
}
