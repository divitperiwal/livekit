/**
 * Money movement.
 *
 * The ledger is append-only and `org_balances` is a cache of it. Every entry
 * carries an idempotency key, and the balance is only ever moved in the same
 * transaction as the entry that justifies it -- so the two can be reconciled
 * by summing, and a disagreement is diagnosable rather than mysterious.
 *
 * Nothing here updates or deletes an entry. A correction is another entry.
 */

import { eq, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { ledgerEntries, orgBalances } from "../db/schema";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface LedgerInput {
  orgId: string;
  kind: "usage" | "topup" | "adjustment" | "refund";
  /** Negative for usage, positive for a top-up. */
  amountInr: number;
  idempotencyKey: string;
  usageRecordId?: string | null;
  description?: string | null;
}

/**
 * Appends an entry and moves the balance, atomically.
 *
 * Returns false when the key has been seen before, which is the normal outcome
 * of a retry rather than an error: a call finalised twice must move the balance
 * once.
 */
export async function post(tx: Tx | Database, input: LedgerInput): Promise<boolean> {
  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      amountInr: input.amountInr.toString(),
      idempotencyKey: input.idempotencyKey,
      usageRecordId: input.usageRecordId ?? null,
      description: input.description ?? null,
    })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });

  if (inserted.length === 0) {
    return false; // already applied
  }

  // Upsert rather than update: an organisation's first charge may arrive
  // before anyone has given it a balance row.
  await tx
    .insert(orgBalances)
    .values({
      orgId: input.orgId,
      balanceInr: input.amountInr.toString(),
    })
    .onConflictDoUpdate({
      target: orgBalances.orgId,
      set: {
        balanceInr: sql`${orgBalances.balanceInr} + ${input.amountInr.toString()}::numeric`,
        updatedAt: new Date(),
      },
    });

  return true;
}

export interface Standing {
  balanceInr: number;
  creditLimitInr: number;
  /** Whether this organisation may start another call. */
  canPlaceCalls: boolean;
  /** What is left to spend, for capping a single call's budget. */
  availableInr: number;
}

/**
 * Whether an organisation is good for another call.
 *
 * Read before a call is answered rather than after, because a refusal is only
 * useful while it can still prevent the spend.
 */
export async function standing(db: Database, orgId: string): Promise<Standing> {
  const rows = await db
    .select()
    .from(orgBalances)
    .where(eq(orgBalances.orgId, orgId))
    .limit(1);

  const row = rows[0];
  // No row means nobody has funded this organisation yet. Treated as zero
  // rather than as unlimited: the safe reading of missing data is that there
  // is no money, not that there is no limit.
  const balance = row ? Number(row.balanceInr) : 0;
  const creditLimit = row ? Number(row.creditLimitInr) : 0;
  const available = balance + creditLimit;

  return {
    balanceInr: balance,
    creditLimitInr: creditLimit,
    canPlaceCalls: available > 0,
    availableInr: Math.max(0, available),
  };
}

/**
 * Rebuilds a balance from the ledger.
 *
 * The cache exists so a call start is one indexed read rather than a sum over
 * every entry. This is how it is checked, and how it is repaired.
 */
export async function recomputeBalance(db: Database, orgId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountInr}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.orgId, orgId));

  const total = Number(rows[0]?.total ?? 0);

  await db
    .insert(orgBalances)
    .values({ orgId, balanceInr: total.toString() })
    .onConflictDoUpdate({
      target: orgBalances.orgId,
      set: { balanceInr: total.toString(), updatedAt: new Date() },
    });

  return total;
}
