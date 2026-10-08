import { and, eq, gte, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db/database";
import { accountLedger, usageRecords } from "../../db/schema";
import { startOfIndianDay, startOfIndianMonth } from "../time/india";

type Reader = Database | DatabaseTransaction;

/** Unpaid = usage − payments − adjustments, summed from the ledger. */
export async function unpaidUsageInr(db: Reader, accountId: string): Promise<number> {
  const [row] = await db
    .select({
      unpaid: sql<string>`coalesce(sum(case when ${accountLedger.kind} = 'usage' then ${accountLedger.amountInr} else -${accountLedger.amountInr} end), 0)`,
    })
    .from(accountLedger)
    .where(eq(accountLedger.accountId, accountId));
  return Number(row?.unpaid ?? 0);
}

/** What the account was charged since midnight IST. */
export async function usageTodayInr(db: Reader, accountId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageRecords.priceInr}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.accountId, accountId),
        gte(usageRecords.createdAt, startOfIndianDay(now)),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Billable seconds the account has used since the 1st of this month, IST. */
export async function billableSecondsThisMonth(
  db: Reader,
  accountId: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageRecords.billableSeconds}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.accountId, accountId),
        gte(usageRecords.createdAt, startOfIndianMonth(now)),
      ),
    );
  return Number(row?.total ?? 0);
}
