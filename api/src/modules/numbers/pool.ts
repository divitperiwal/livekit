import { asc, eq } from "drizzle-orm";
import type { Database } from "../../db/database";
import { agents, orgs, phoneNumbers } from "../../db/schema";

export const E164 = /^\+[1-9]\d{6,14}$/;

/** A number we bought (Plivo), into our pool, unassigned. Returns false if it is already on file. */
export async function addPoolNumber(db: Database, e164: string): Promise<boolean> {
  const inserted = await db
    .insert(phoneNumbers)
    .values({ e164, status: "available" })
    .onConflictDoNothing({ target: phoneNumbers.e164 })
    .returning({ id: phoneNumbers.id });
  return inserted.length > 0;
}

export function listNumbers(db: Database) {
  return db
    .select({
      e164: phoneNumbers.e164,
      status: phoneNumbers.status,
      org: orgs.externalId,
      agent: agents.slug,
    })
    .from(phoneNumbers)
    .leftJoin(orgs, eq(orgs.id, phoneNumbers.orgId))
    .leftJoin(agents, eq(agents.id, phoneNumbers.agentId))
    .orderBy(asc(phoneNumbers.e164));
}
