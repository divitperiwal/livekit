import { eq } from "drizzle-orm";
import type { Database } from "../../db/database";
import { accounts } from "../../db/schema";
import type { SecretBox } from "../secrets/secret-box";
import { unpaidInr, usageTodayInr } from "./account-usage";
import type { BalanceChecker } from "./balance-check";

export type CreditCheckResult =
  { allowed: true; availableInr: number | null } | { allowed: false; reason: string };

export type CreditCheckDependencies = {
  db: Database;
  balanceChecker: BalanceChecker;
  secretBox: SecretBox;
  now?: () => Date;
};

/**
 * The one credit check. A call starts only if the account is active, its unpaid usage is
 * under `credit_cap_inr` (when set), today's usage is under `daily_cap_inr` (when set),
 * and its balance URL (when set) returns `availableInr > 0` or does not answer.
 * `availableInr` is the least of what each limit leaves, capping the call's own budget;
 * null when nothing limits it.
 */
export async function checkCredit(
  { db, balanceChecker, secretBox, now = () => new Date() }: CreditCheckDependencies,
  accountId: string,
  orgExternalId: string,
): Promise<CreditCheckResult> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return { allowed: false, reason: "account not found" };
  if (account.status !== "active") return { allowed: false, reason: "account suspended" };

  const limits: number[] = [];

  if (account.creditCapInr !== null) {
    const left = Number(account.creditCapInr) - (await unpaidInr(db, accountId));
    if (left <= 0) return { allowed: false, reason: "credit cap reached" };
    limits.push(left);
  }

  if (account.dailyCapInr !== null) {
    const left = Number(account.dailyCapInr) - (await usageTodayInr(db, accountId, now()));
    if (left <= 0) return { allowed: false, reason: "daily cap reached" };
    limits.push(left);
  }

  if (account.balanceCheckUrl !== null && account.balanceCheckSecretCiphertext !== null) {
    const balance = await balanceChecker.availableInr({
      accountId,
      url: account.balanceCheckUrl,
      bearerSecret: secretBox.decrypt(account.balanceCheckSecretCiphertext),
      orgExternalId,
    });
    if (balance !== null) {
      if (balance <= 0) return { allowed: false, reason: "no balance" };
      limits.push(balance);
    }
  }

  return {
    allowed: true,
    availableInr: limits.length > 0 ? Math.round(Math.min(...limits) * 100) / 100 : null,
  };
}

export type RentCheckResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Renting a number: the account is active and its unpaid charges are under its credit cap.
 * The business's wallet is not asked; the account checks it before renting.
 */
export async function checkAccountMayRent(
  db: Database,
  accountId: string,
): Promise<RentCheckResult> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return { allowed: false, reason: "account not found" };
  if (account.status !== "active") return { allowed: false, reason: "account suspended" };
  if (account.creditCapInr === null) return { allowed: true };
  const left = Number(account.creditCapInr) - (await unpaidInr(db, accountId));
  return left > 0 ? { allowed: true } : { allowed: false, reason: "credit cap reached" };
}
