import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../../db/database";
import { agents, phoneNumbers } from "../../db/schema";
import { isUuid } from "../ids";

export function listOrgNumbers(db: Database, orgId: string) {
  return db
    .select({
      number: phoneNumbers.e164,
      direction: phoneNumbers.direction,
      agentId: phoneNumbers.agentId,
    })
    .from(phoneNumbers)
    .where(eq(phoneNumbers.orgId, orgId))
    .orderBy(asc(phoneNumbers.e164));
}

export type PointNumberOutcome = { kind: "ok" } | { kind: "not_found"; reason: string };

/** Which of the org's agents answers one of its numbers; null leaves it unanswered. */
export async function pointNumberAtAgent(
  db: Database,
  orgId: string,
  e164: string,
  agentId: string | null,
): Promise<PointNumberOutcome> {
  if (agentId !== null) {
    if (!isUuid(agentId)) return { kind: "not_found", reason: "agent not found" };
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), eq(agents.status, "active")));
    if (!agent) return { kind: "not_found", reason: "agent not found" };
  }
  const updated = await db
    .update(phoneNumbers)
    .set({ agentId })
    .where(and(eq(phoneNumbers.e164, e164), eq(phoneNumbers.orgId, orgId)))
    .returning({ id: phoneNumbers.id });
  return updated.length > 0
    ? { kind: "ok" }
    : { kind: "not_found", reason: "the org has no such number" };
}
