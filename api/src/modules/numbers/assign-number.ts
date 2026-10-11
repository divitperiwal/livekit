import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/database";
import { phoneNumbers } from "../../db/schema";
import type { OrgRow } from "../orgs/orgs";
import type { Plivo } from "./plivo";

export type AssignOutcome = { kind: "assigned" } | { kind: "refused"; reason: string };

/**
 * Gives one of our pool numbers to a business (managed accounts, from the ops CLI). Plivo
 * requires the number to sit under that business's own accepted KYC application.
 */
export async function assignPoolNumber(
  deps: { db: Database; plivo: Plivo },
  e164: string,
  org: OrgRow,
): Promise<AssignOutcome> {
  if (org.numberKycStatus !== "accepted" || org.numberKycApplicationId === null) {
    return { kind: "refused", reason: "number KYC not accepted" };
  }
  const inPool = and(
    eq(phoneNumbers.e164, e164),
    isNull(phoneNumbers.releasedAt),
    eq(phoneNumbers.status, "available"),
  );
  const [number] = await deps.db.select({ id: phoneNumbers.id }).from(phoneNumbers).where(inPool);
  if (!number) return { kind: "refused", reason: `${e164} is not an available pool number` };

  await deps.plivo.linkNumbers(org.numberKycApplicationId, [e164]);
  const assigned = await deps.db
    .update(phoneNumbers)
    .set({ orgId: org.id, status: "assigned" })
    .where(and(eq(phoneNumbers.id, number.id), eq(phoneNumbers.status, "available")))
    .returning({ id: phoneNumbers.id });
  if (assigned.length === 0) {
    return { kind: "refused", reason: `${e164} was assigned elsewhere meanwhile` };
  }
  return { kind: "assigned" };
}
