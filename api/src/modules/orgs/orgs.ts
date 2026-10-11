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

export type OrgRow = typeof orgs.$inferSelect;

/** The account's org by its external id; null for another account's or a deleted one. */
export async function findLiveOrg(
  db: Database,
  accountId: string,
  externalId: string,
): Promise<OrgRow | null> {
  const [org] = await db
    .select()
    .from(orgs)
    .where(
      and(eq(orgs.accountId, accountId), eq(orgs.externalId, externalId), isNull(orgs.deletedAt)),
    );
  return org ?? null;
}

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

export type DeleteOrgOutcome = { kind: "deleted" } | { kind: "holds_numbers"; numbers: string[] };

/**
 * Soft delete: its agents are archived; calls, usage and the do-not-call list are kept.
 * Refused while it holds numbers: they are released first (rented ones through `/v1`,
 * ours from the ops CLI), so a number is never taken off WhatsApp by surprise.
 */
export async function deleteOrg(
  db: Database,
  orgId: string,
  now = new Date(),
): Promise<DeleteOrgOutcome> {
  return db.transaction(async (tx): Promise<DeleteOrgOutcome> => {
    const held = await tx
      .select({ e164: phoneNumbers.e164 })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.orgId, orgId), isNull(phoneNumbers.releasedAt)))
      .orderBy(asc(phoneNumbers.e164));
    if (held.length > 0) return { kind: "holds_numbers", numbers: held.map((row) => row.e164) };
    await tx.update(agents).set({ status: "archived" }).where(eq(agents.orgId, orgId));
    await tx.update(orgs).set({ deletedAt: now }).where(eq(orgs.id, orgId));
    return { kind: "deleted" };
  });
}
