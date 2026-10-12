import { and, asc, desc, eq, gte, isNull, or } from "drizzle-orm";
import { onlyRow, type Database, type DatabaseTransaction } from "../../db/database";
import { orgs, phoneNumbers, suppressedNumbers, uccComplaints } from "../../db/schema";
import { enqueueWebhook } from "../webhooks/enqueue";
import { PlivoError, type Plivo, type PlivoFile, type UccComplaint } from "./plivo";

/** Past any complaint still open: 5 business days to send proof, about a week for Plivo to review it. */
export const UCC_LOOKBACK_DAYS = 45;
export const UCC_PROOF_MAX_BYTES = 10 * 1024 * 1024;
export const UCC_PROOF_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type UccComplaintRow = typeof uccComplaints.$inferSelect;
type OrgRef = { id: string; accountId: string; externalId: string };
export type UccDependencies = { db: Database; plivo: Plivo; now?: () => Date };

/** A complaint as accounts see it, in `ucc_complaint.updated` and under /v1. */
export function toPublicUccComplaint(complaint: UccComplaintRow, org: { externalId: string }) {
  return {
    orgId: org.externalId,
    referenceId: complaint.referenceId,
    status: complaint.status,
    fromNumber: complaint.fromNumber,
    complainantNumber: complaint.complainantNumber,
    calledOn: complaint.calledOn,
    category: complaint.category,
    rejectionReason: complaint.rejectionReason,
    reportedAt: complaint.reportedAt.toISOString(),
    proofSubmittedAt: complaint.proofSubmittedAt?.toISOString() ?? null,
  };
}

export type UccSyncResult = { created: number; changed: number; unmatched: string[] };

/**
 * Reads recent complaints from Plivo and records what is new or changed. A new complaint
 * puts the complainant on its org's do-not-call list at once (calling them again is
 * itself a violation) and, like every status change, tells the account.
 */
export async function syncUccComplaints(deps: UccDependencies): Promise<UccSyncResult> {
  const now = deps.now?.() ?? new Date();
  const complaints = await deps.plivo.uccComplaints(
    new Date(now.getTime() - UCC_LOOKBACK_DAYS * DAY_MS),
  );
  const result: UccSyncResult = { created: 0, changed: 0, unmatched: [] };
  for (const complaint of complaints) {
    const outcome = await recordComplaint(deps.db, complaint);
    if (outcome === "created" || outcome === "created_unmatched") result.created += 1;
    if (outcome === "created_unmatched") result.unmatched.push(complaint.referenceId);
    if (outcome === "changed") result.changed += 1;
  }
  return result;
}

type RecordOutcome = "created" | "created_unmatched" | "changed" | "unchanged";

async function recordComplaint(db: Database, complaint: UccComplaint): Promise<RecordOutcome> {
  return db.transaction(async (tx): Promise<RecordOutcome> => {
    const [known] = await tx
      .select()
      .from(uccComplaints)
      .where(eq(uccComplaints.referenceId, complaint.referenceId))
      .for("update");
    if (!known) return createComplaint(tx, complaint);

    const unchanged =
      known.status === complaint.status && known.rejectionReason === complaint.rejectionReason;
    if (unchanged) return "unchanged";
    const updated = await tx
      .update(uccComplaints)
      .set({
        status: complaint.status,
        rejectionReason: complaint.rejectionReason,
        plivoUpdatedAt: complaint.updatedAt,
      })
      .where(eq(uccComplaints.id, known.id))
      .returning()
      .then(onlyRow);
    await tellAccount(tx, updated, complaint.updatedAt);
    return "changed";
  });
}

async function createComplaint(
  tx: DatabaseTransaction,
  complaint: UccComplaint,
): Promise<RecordOutcome> {
  const org = await orgHoldingNumber(tx, complaint.fromNumber, complaint.calledOn);
  const created = await tx
    .insert(uccComplaints)
    .values({
      referenceId: complaint.referenceId,
      orgId: org?.id ?? null,
      fromNumber: complaint.fromNumber,
      complainantNumber: complaint.complainantNumber,
      calledOn: complaint.calledOn,
      category: complaint.category,
      plivoCallUuid: complaint.callUuid,
      status: complaint.status,
      rejectionReason: complaint.rejectionReason,
      reportedAt: complaint.reportedAt,
      plivoUpdatedAt: complaint.updatedAt,
    })
    .returning()
    .then(onlyRow);
  if (!org) return "created_unmatched";

  await tx
    .insert(suppressedNumbers)
    .values({
      orgId: org.id,
      e164: complaint.complainantNumber,
      source: "complaint",
      reason: `UCC complaint ${complaint.referenceId}`,
      createdBy: "plivo-ucc",
    })
    .onConflictDoNothing();
  await tellAccount(tx, created, complaint.updatedAt);
  return "created";
}

/**
 * The org that held the number on the day of the call. A number never moves between
 * businesses (it goes back to Plivo and may be bought again), so its rows follow one
 * another in time: the first one not released before that day is the one.
 */
async function orgHoldingNumber(
  tx: DatabaseTransaction,
  e164: string,
  calledOn: string,
): Promise<OrgRef | null> {
  const dayStartIst = new Date(`${calledOn}T00:00:00+05:30`);
  const [holding] = await tx
    .select({ id: orgs.id, accountId: orgs.accountId, externalId: orgs.externalId })
    .from(phoneNumbers)
    .innerJoin(orgs, eq(orgs.id, phoneNumbers.orgId))
    .where(
      and(
        eq(phoneNumbers.e164, e164),
        or(isNull(phoneNumbers.releasedAt), gte(phoneNumbers.releasedAt, dayStartIst)),
      ),
    )
    .orderBy(asc(phoneNumbers.createdAt))
    .limit(1);
  return holding ?? null;
}

/** One event per status change, keyed as Plivo's own callbacks are: reference, status, time. */
async function tellAccount(tx: DatabaseTransaction, complaint: UccComplaintRow, changedAt: Date) {
  if (complaint.orgId === null) return;
  const [org] = await tx
    .select({ accountId: orgs.accountId, externalId: orgs.externalId })
    .from(orgs)
    .where(eq(orgs.id, complaint.orgId));
  if (!org) return;
  await enqueueWebhook(tx, {
    accountId: org.accountId,
    orgId: complaint.orgId,
    type: "ucc_complaint.updated",
    key: `${complaint.referenceId}:${complaint.status}:${changedAt.toISOString()}`,
    payload: toPublicUccComplaint(complaint, org),
  });
}

/** Newest first. Complaints are few: five in ten days suspend the org's numbers. */
export function listUccComplaints(db: Database, org: { id: string }) {
  return db
    .select()
    .from(uccComplaints)
    .where(eq(uccComplaints.orgId, org.id))
    .orderBy(desc(uccComplaints.reportedAt));
}

export async function findUccComplaint(db: Database, org: { id: string }, referenceId: string) {
  const [complaint] = await db
    .select()
    .from(uccComplaints)
    .where(and(eq(uccComplaints.orgId, org.id), eq(uccComplaints.referenceId, referenceId)));
  return complaint ?? null;
}

export type SubmitProofOutcome =
  | { kind: "submitted"; complaint: UccComplaintRow }
  | { kind: "not_found" }
  /** Under review or accepted, or Plivo refused it (e.g. the window has passed). */
  | { kind: "refused"; reason: string }
  | { kind: "invalid_file"; reason: string };

/**
 * Sends the business's opt-in proof (its logo or name, the opt-in date within 6 months
 * before the complaint, the complainant's number) straight to Plivo; the file is not kept.
 */
export async function submitUccProof(
  deps: UccDependencies,
  org: OrgRef,
  referenceId: string,
  file: PlivoFile,
): Promise<SubmitProofOutcome> {
  const complaint = await findUccComplaint(deps.db, org, referenceId);
  if (!complaint) return { kind: "not_found" };
  if (complaint.status === "in_review") {
    return { kind: "refused", reason: "proof for this complaint is already under review" };
  }
  if (complaint.status === "accepted") {
    return { kind: "refused", reason: "this complaint is already resolved" };
  }
  const badFile = invalidProof(file);
  if (badFile) return { kind: "invalid_file", reason: badFile };

  try {
    await deps.plivo.submitUccProof(referenceId, file);
  } catch (error) {
    if (error instanceof PlivoError && error.status === 400) {
      return { kind: "refused", reason: `Plivo refused the proof: ${error.plivoMessage}` };
    }
    throw error;
  }
  const now = deps.now?.() ?? new Date();
  const updated = await deps.db.transaction(async (tx): Promise<UccComplaintRow> => {
    const row = await tx
      .update(uccComplaints)
      .set({ status: "in_review", rejectionReason: null, proofSubmittedAt: now })
      .where(eq(uccComplaints.id, complaint.id))
      .returning()
      .then(onlyRow);
    await tellAccount(tx, row, now);
    return row;
  });
  return { kind: "submitted", complaint: updated };
}

function invalidProof(file: PlivoFile): string | null {
  if (!(UCC_PROOF_TYPES as readonly string[]).includes(file.content.type)) {
    return "file must be a PDF, JPEG or PNG";
  }
  if (file.content.size > UCC_PROOF_MAX_BYTES) return "file must be 10 MB or less";
  return null;
}
