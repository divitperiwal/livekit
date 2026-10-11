import { and, eq } from "drizzle-orm";
import { onlyRow, type Database } from "../../db/database";
import { accountLedger, numberRents, phoneNumbers } from "../../db/schema";
import { errorMessage } from "../../error-message";
import { checkAccountMayRent } from "../billing/credit-check";
import { findRateCard } from "../billing/rate-card";
import type { OrgRow } from "../orgs/orgs";
import { addIndianMonths } from "../time/india";
import { enqueueWebhook } from "../webhooks/enqueue";
import type { NumberServices } from "./number-services";
import { PlivoError, type NumberSearch } from "./plivo";

export type RentDependencies = { db: Database; numbers: NumberServices; now?: () => Date };

type NumberRow = typeof phoneNumbers.$inferSelect;

export type RentedNumber = {
  number: string;
  monthlyRentInr: number;
  rentedAt: string;
  nextChargeAt: string;
};

export type RentOutcome =
  | { kind: "rented"; number: RentedNumber }
  | {
      kind:
        | "kyc_not_accepted"
        | "no_credit"
        | "not_offered"
        | "unavailable"
        | "key_reused"
        /** Plivo did not answer; the same request key resumes the rent. */
        | "provider_failed";
      reason: string;
    };

export type AvailableNumbers =
  | {
      kind: "found";
      numbers: {
        number: string;
        city: string | null;
        region: string | null;
        monthlyRentInr: number;
      }[];
    }
  | { kind: "not_offered"; reason: string };

const notOffered = {
  kind: "not_offered",
  reason: "renting numbers is not on this account's rate card",
} as const;

/** Plivo's numbers with this account's monthly rent, so the account can check its wallet first. */
export async function findRentableNumbers(
  deps: RentDependencies,
  accountId: string,
  search: NumberSearch,
): Promise<AvailableNumbers> {
  const monthlyRentInr = await rentOnCard(deps, accountId);
  if (monthlyRentInr === null) return notOffered;
  const found = await deps.numbers.plivo.searchNumbers(search);
  return {
    kind: "found",
    numbers: found.map((number) => ({
      number: number.e164,
      city: number.city,
      region: number.region,
      monthlyRentInr,
    })),
  };
}

/**
 * Buys a number for the org, sends its calls to our inbound trunk, and charges the first
 * month. A `renting` row is written before Plivo is asked, so a crash between buying and
 * saving is never lost; the request key makes a retry resume that row. A definite refusal
 * from Plivo saves and charges nothing.
 */
export async function rentNumber(
  deps: RentDependencies,
  org: OrgRow,
  request: { e164: string; requestKey: string },
): Promise<RentOutcome> {
  const earlier = await findRentRequest(deps.db, org.id, request.requestKey);
  if (earlier) return resumeRent(deps, org, earlier, request.e164);

  if (org.numberKycStatus !== "accepted") {
    return { kind: "kyc_not_accepted", reason: "number KYC not accepted" };
  }
  const credit = await checkAccountMayRent(deps.db, org.accountId);
  if (!credit.allowed) return { kind: "no_credit", reason: credit.reason };
  const monthlyRentInr = await rentOnCard(deps, org.accountId);
  if (monthlyRentInr === null) return notOffered;

  const reservation = await reserve(deps.db, org, request, monthlyRentInr);
  if (!reservation) return { kind: "unavailable", reason: `${request.e164} is already taken` };
  return completeRent(deps, org, reservation);
}

async function resumeRent(
  deps: RentDependencies,
  org: OrgRow,
  earlier: NumberRow,
  e164: string,
): Promise<RentOutcome> {
  if (earlier.e164 !== e164) {
    return { kind: "key_reused", reason: "this Idempotency-Key was used for another number" };
  }
  if (earlier.status === "renting") return completeRent(deps, org, earlier);
  return { kind: "rented", number: toRentedNumber(earlier, deps.now?.() ?? new Date()) };
}

async function findRentRequest(db: Database, orgId: string, requestKey: string) {
  const [row] = await db
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.orgId, orgId), eq(phoneNumbers.rentRequestKey, requestKey)));
  return row ?? null;
}

async function rentOnCard(deps: RentDependencies, accountId: string): Promise<number | null> {
  const card = await findRateCard(deps.db, accountId, deps.now?.() ?? new Date());
  return card?.rates.numberMonthlyRentInr ?? null;
}

/** Null when another org holds the number or is renting it right now. */
async function reserve(
  db: Database,
  org: OrgRow,
  request: { e164: string; requestKey: string },
  monthlyRentInr: number,
): Promise<NumberRow | null> {
  const [row] = await db
    .insert(phoneNumbers)
    .values({
      e164: request.e164,
      orgId: org.id,
      source: "rented",
      status: "renting",
      monthlyRentInr: monthlyRentInr.toFixed(2),
      rentRequestKey: request.requestKey,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

async function completeRent(
  deps: RentDependencies,
  org: OrgRow,
  reservation: NumberRow,
): Promise<RentOutcome> {
  const { plivo, inboundTrunkId } = deps.numbers;
  const forget = () => deps.db.delete(phoneNumbers).where(eq(phoneNumbers.id, reservation.id));
  let bought = false;
  try {
    bought = await plivo.holdsNumber(reservation.e164);
    if (!bought) {
      const applicationId = org.numberKycStatus === "accepted" ? org.numberKycApplicationId : null;
      if (applicationId === null) {
        await forget();
        return { kind: "kyc_not_accepted", reason: "number KYC not accepted" };
      }
      await plivo.buyNumber(reservation.e164, applicationId);
      bought = true;
    }
    await plivo.connectNumber(reservation.e164, inboundTrunkId);
  } catch (error) {
    if (!bought && isDefiniteRefusal(error)) {
      await forget();
      return { kind: "unavailable", reason: `Plivo refused: ${errorMessage(error)}` };
    }
    return { kind: "provider_failed", reason: errorMessage(error) };
  }
  const now = deps.now?.() ?? new Date();
  return { kind: "rented", number: await chargeFirstMonth(deps.db, org, reservation, now) };
}

/** Plivo answered and said no (4xx): nothing was bought. A timeout or 5xx may have bought it. */
function isDefiniteRefusal(error: unknown): boolean {
  return error instanceof PlivoError && error.status !== null && error.status < 500;
}

async function chargeFirstMonth(
  db: Database,
  org: OrgRow,
  reservation: NumberRow,
  rentedAt: Date,
): Promise<RentedNumber> {
  return db.transaction(async (tx): Promise<RentedNumber> => {
    const [assigned] = await tx
      .update(phoneNumbers)
      .set({ status: "assigned", rentedAt })
      .where(and(eq(phoneNumbers.id, reservation.id), eq(phoneNumbers.status, "renting")))
      .returning();
    if (!assigned) {
      // Another request with the same key finished first and charged.
      const current = await tx
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.id, reservation.id));
      return toRentedNumber(onlyRow(current), rentedAt);
    }
    const rent = await tx
      .insert(numberRents)
      .values({
        accountId: org.accountId,
        orgId: org.id,
        phoneNumberId: assigned.id,
        periodStart: rentedAt,
        periodEnd: addIndianMonths(rentedAt, 1),
        amountInr: monthlyRent(reservation),
      })
      .returning()
      .then(onlyRow);
    await tx.insert(accountLedger).values({
      accountId: org.accountId,
      kind: "number_rent",
      amountInr: rent.amountInr,
      numberRentId: rent.id,
      idempotencyKey: `number_rent:${rent.id}`,
      description: `${assigned.e164} ${rent.periodStart.toISOString()}`,
    });
    const rented = toRentedNumber(assigned, rentedAt);
    await enqueueWebhook(tx, {
      accountId: org.accountId,
      orgId: org.id,
      type: "number.rented",
      key: assigned.id,
      payload: { orgId: org.externalId, ...rented },
    });
    await enqueueWebhook(tx, {
      accountId: org.accountId,
      orgId: org.id,
      type: "number.rent_charged",
      key: rent.id,
      payload: numberRentPayload(org.externalId, assigned.e164, rent),
    });
    return rented;
  });
}

/** `number.rent_charged`: what the account bills its business for, keyed on `numberRentId`. */
export function numberRentPayload(
  orgExternalId: string,
  e164: string,
  rent: typeof numberRents.$inferSelect,
) {
  return {
    orgId: orgExternalId,
    number: e164,
    numberRentId: rent.id,
    amountInr: Number(rent.amountInr),
    periodStart: rent.periodStart.toISOString(),
    periodEnd: rent.periodEnd.toISOString(),
  };
}

function toRentedNumber(row: NumberRow, now: Date): RentedNumber {
  if (row.rentedAt === null) throw new Error(`number ${row.id} is not rented yet`);
  return {
    number: row.e164,
    monthlyRentInr: Number(monthlyRent(row)),
    rentedAt: row.rentedAt.toISOString(),
    nextChargeAt: nextRentDate(row.rentedAt, now).toISOString(),
  };
}

/** The first monthly anniversary of `rentedAt` after `now`. */
export function nextRentDate(rentedAt: Date, now: Date): Date {
  let months = 1;
  while (addIndianMonths(rentedAt, months) <= now) months += 1;
  return addIndianMonths(rentedAt, months);
}

/** A rented number always carries its rent (a check constraint). */
function monthlyRent(row: NumberRow): string {
  if (row.monthlyRentInr === null) throw new Error(`number ${row.id} has no monthly rent`);
  return row.monthlyRentInr;
}
