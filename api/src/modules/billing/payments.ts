import type { Database } from "../../db/database";
import { accountLedger } from "../../db/schema";

export type LedgerWriteResult = { recorded: boolean };

/**
 * Records money received, by hand. Idempotent on the payment's own reference, so
 * entering the same payment twice records it once.
 */
export async function recordPayment(
  db: Database,
  input: { accountId: string; amountInr: string; reference: string; createdBy: string },
): Promise<LedgerWriteResult> {
  const inserted = await db
    .insert(accountLedger)
    .values({
      accountId: input.accountId,
      kind: "payment",
      amountInr: input.amountInr,
      reference: input.reference,
      idempotencyKey: `payment:${input.reference}`,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: accountLedger.idempotencyKey })
    .returning({ id: accountLedger.id });
  return { recorded: inserted.length > 0 };
}

/** A correction: positive credits the account, negative debits it. Idempotent on `reference`. */
export async function recordAdjustment(
  db: Database,
  input: {
    accountId: string;
    amountInr: string;
    reference: string;
    reason: string;
    createdBy: string;
  },
): Promise<LedgerWriteResult> {
  const inserted = await db
    .insert(accountLedger)
    .values({
      accountId: input.accountId,
      kind: "adjustment",
      amountInr: input.amountInr,
      reference: input.reference,
      description: input.reason,
      idempotencyKey: `adjustment:${input.reference}`,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: accountLedger.idempotencyKey })
    .returning({ id: accountLedger.id });
  return { recorded: inserted.length > 0 };
}
