import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { onlyRow, type Database } from "../../db/database";
import { accounts, calls, orgs } from "../../db/schema";
import { unpaidUsageInr, usageTodayInr } from "../billing/account-usage";
import type { SecretBox } from "../secrets/secret-box";

export const ACCOUNT_SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

type AccountRow = typeof accounts.$inferSelect;

/** A limit to set, or null to remove it. Omitted = unchanged. */
export type AccountLimits = {
  creditCapInr?: string | null;
  dailyCapInr?: string | null;
  balanceCheck?: { url: string; bearerSecret: string } | null;
};

function limitColumns(secretBox: SecretBox, limits: AccountLimits) {
  return {
    ...(limits.creditCapInr !== undefined && { creditCapInr: limits.creditCapInr }),
    ...(limits.dailyCapInr !== undefined && { dailyCapInr: limits.dailyCapInr }),
    ...(limits.balanceCheck !== undefined && {
      balanceCheckUrl: limits.balanceCheck?.url ?? null,
      balanceCheckSecretCiphertext: limits.balanceCheck
        ? secretBox.encrypt(limits.balanceCheck.bearerSecret)
        : null,
    }),
  };
}

export async function createAccount(
  db: Database,
  secretBox: SecretBox,
  input: { slug: string; name: string } & AccountLimits,
): Promise<AccountRow> {
  return db
    .insert(accounts)
    .values({ slug: input.slug, name: input.name, ...limitColumns(secretBox, input) })
    .returning()
    .then(onlyRow);
}

export async function findAccount(db: Database, slug: string): Promise<AccountRow | null> {
  const [account] = await db.select().from(accounts).where(eq(accounts.slug, slug));
  return account ?? null;
}

export async function updateAccountLimits(
  db: Database,
  secretBox: SecretBox,
  accountId: string,
  limits: AccountLimits,
) {
  return db
    .update(accounts)
    .set(limitColumns(secretBox, limits))
    .where(eq(accounts.id, accountId))
    .returning()
    .then(onlyRow);
}

export async function setAccountStatus(
  db: Database,
  accountId: string,
  status: AccountRow["status"],
) {
  const [account] = await db
    .update(accounts)
    .set({ status })
    .where(eq(accounts.id, accountId))
    .returning();
  return account;
}

/** LiveKit rooms of the account's calls still on the line. */
export async function liveCallRooms(db: Database, accountId: string): Promise<string[]> {
  const rows = await db
    .select({ room: calls.lkRoomName })
    .from(calls)
    .innerJoin(orgs, eq(orgs.id, calls.orgId))
    .where(
      and(
        eq(orgs.accountId, accountId),
        inArray(calls.status, ["ringing", "in_progress"]),
        isNotNull(calls.lkRoomName),
      ),
    );
  return rows.map((row) => row.room!);
}

export async function accountSummary(db: Database, account: AccountRow, now = new Date()) {
  return {
    slug: account.slug,
    name: account.name,
    status: account.status,
    creditCapInr: account.creditCapInr,
    dailyCapInr: account.dailyCapInr,
    balanceCheckUrl: account.balanceCheckUrl,
    unpaidInr: await unpaidUsageInr(db, account.id),
    usageTodayInr: await usageTodayInr(db, account.id, now),
    liveCalls: (await liveCallRooms(db, account.id)).length,
  };
}

export function listAccounts(db: Database) {
  return db
    .select({
      slug: accounts.slug,
      name: accounts.name,
      status: accounts.status,
      creditCapInr: accounts.creditCapInr,
    })
    .from(accounts)
    .orderBy(asc(accounts.slug));
}
