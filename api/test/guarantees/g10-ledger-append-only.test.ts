import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { accountLedger } from "../../src/db/schema";
import { seedAccount } from "../db/seed";
import { createTestDatabase, postgresError } from "../db/test-database";

describe("guarantee 10: the ledger is append-only", () => {
  async function ledgerWithOnePayment() {
    const { db } = await createTestDatabase();
    const account = await seedAccount(db);
    const [entry] = await db
      .insert(accountLedger)
      .values({
        accountId: account.id,
        kind: "payment",
        amountInr: "5000.00",
        idempotencyKey: "pay-1",
      })
      .returning();
    return { db, entry: entry! };
  }

  test("an entry cannot be changed", async () => {
    const { db, entry } = await ledgerWithOnePayment();
    const error = await postgresError(
      db.update(accountLedger).set({ amountInr: "1.00" }).where(eq(accountLedger.id, entry.id)),
    );
    expect(error.message).toContain("append-only");
  });

  test("an entry cannot be deleted", async () => {
    const { db, entry } = await ledgerWithOnePayment();
    const error = await postgresError(
      db.delete(accountLedger).where(eq(accountLedger.id, entry.id)),
    );
    expect(error.message).toContain("append-only");
  });

  test("a retried write with the same idempotency key inserts nothing", async () => {
    const { db, entry } = await ledgerWithOnePayment();
    await db
      .insert(accountLedger)
      .values({
        accountId: entry.accountId,
        kind: "payment",
        amountInr: "5000.00",
        idempotencyKey: "pay-1",
      })
      .onConflictDoNothing({ target: accountLedger.idempotencyKey });
    const [{ count }] = (await db.execute(sql`select count(*)::int as count from account_ledger`))
      .rows as [{ count: number }];
    expect(count).toBe(1);
  });
});
