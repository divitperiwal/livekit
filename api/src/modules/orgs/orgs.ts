import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { onlyRow, type Database } from "../../db/database";
import { agents, orgs, phoneNumbers } from "../../db/schema";

/** The account's own id for the business. */
export const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export const orgInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  recordCalls: z.boolean().optional(),
  recordingRetentionDays: z.number().int().min(1).max(3650).optional(),
  redactPii: z.boolean().optional(),
});
export type OrgInput = z.infer<typeof orgInputSchema>;

type OrgRow = typeof orgs.$inferSelect;

export const toPublicOrg = (org: OrgRow) => ({
  id: org.externalId,
  name: org.name,
  status: org.status,
  recordCalls: org.recordCalls,
  recordingRetentionDays: org.recordingRetentionDays,
  redactPii: org.redactPii,
  createdAt: org.createdAt.toISOString(),
  updatedAt: org.updatedAt.toISOString(),
});

export type UpsertOrgOutcome = { kind: "created" | "updated"; org: OrgRow } | { kind: "deleted" };

/** Creates the org on first sight of its external id; later calls update what they name. */
export async function upsertOrg(
  db: Database,
  accountId: string,
  externalId: string,
  input: OrgInput,
): Promise<UpsertOrgOutcome> {
  return db.transaction(async (tx): Promise<UpsertOrgOutcome> => {
    const [existing] = await tx
      .select()
      .from(orgs)
      .where(and(eq(orgs.accountId, accountId), eq(orgs.externalId, externalId)))
      .for("update");
    if (existing?.deletedAt) return { kind: "deleted" };

    if (existing) {
      const org = await tx
        .update(orgs)
        .set(input)
        .where(eq(orgs.id, existing.id))
        .returning()
        .then(onlyRow);
      return { kind: "updated", org };
    }

    const org = await tx
      .insert(orgs)
      .values({ accountId, externalId, ...input })
      .returning()
      .then(onlyRow);
    return { kind: "created", org };
  });
}

export function listOrgs(db: Database, accountId: string, page: { after?: string; limit: number }) {
  return db
    .select()
    .from(orgs)
    .where(
      and(
        eq(orgs.accountId, accountId),
        isNull(orgs.deletedAt),
        page.after ? gt(orgs.externalId, page.after) : undefined,
      ),
    )
    .orderBy(asc(orgs.externalId))
    .limit(page.limit);
}

/**
 * Soft delete. Its numbers go back to our pool and its agents are archived, in one
 * transaction; calls, usage and the do-not-call list are kept.
 */
export async function deleteOrg(db: Database, orgId: string, now = new Date()) {
  await db.transaction(async (tx) => {
    await tx
      .update(phoneNumbers)
      .set({ orgId: null, agentId: null, status: "available" })
      .where(eq(phoneNumbers.orgId, orgId));
    await tx.update(agents).set({ status: "archived" }).where(eq(agents.orgId, orgId));
    await tx.update(orgs).set({ deletedAt: now }).where(eq(orgs.id, orgId));
  });
}
