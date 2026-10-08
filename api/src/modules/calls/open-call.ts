import { and, eq } from "drizzle-orm";
import type { OpenCallRequest } from "../../contracts/internal";
import { onlyRow, type Database, type DatabaseTransaction } from "../../db/database";
import { agentVersions, calls, phoneNumbers } from "../../db/schema";
import { isUuid } from "../ids";

export type OpenCallOutcome =
  { kind: "opened"; call: { id: string; orgId: string } } | { kind: "forbidden"; reason: string };

type Reader = Database | DatabaseTransaction;

/** The org's own number the call used: named by the worker, else found by E.164. */
async function phoneNumberFor(db: Reader, request: OpenCallRequest): Promise<string | null> {
  if (isUuid(request.phoneNumberId)) {
    const [owned] = await db
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(eq(phoneNumbers.id, request.phoneNumberId), eq(phoneNumbers.orgId, request.orgId)),
      );
    if (owned) return owned.id;
  }
  const ours = request.direction === "inbound" ? request.toNumber : request.fromNumber;
  if (!ours) return null;
  const [found] = await db
    .select({ id: phoneNumbers.id })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.e164, ours), eq(phoneNumbers.orgId, request.orgId)));
  return found?.id ?? null;
}

const opened = (call: { id: string; orgId: string }): OpenCallOutcome => ({
  kind: "opened",
  call: { id: call.id, orgId: call.orgId },
});

/**
 * One call record per LiveKit job, idempotent on `lkJobId` (guarantee 9). A call placed
 * through `POST /v1/calls` already exists as `queued` under its `requestId`; the open
 * attaches the job to it, so the id the client holds is the call's id. `orgId` is a claim:
 * the version must belong to it.
 */
export async function openCall(
  db: Database,
  request: OpenCallRequest,
  now = new Date(),
): Promise<OpenCallOutcome> {
  if (!isUuid(request.orgId) || !isUuid(request.agentId) || !isUuid(request.agentVersionId)) {
    return { kind: "forbidden", reason: "org does not own this version" };
  }

  const [existing] = await db.select().from(calls).where(eq(calls.lkJobId, request.lkJobId));
  if (existing) {
    return existing.orgId === request.orgId
      ? opened(existing)
      : { kind: "forbidden", reason: "job belongs to another org" };
  }

  const [version] = await db
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.id, request.agentVersionId),
        eq(agentVersions.agentId, request.agentId),
        eq(agentVersions.orgId, request.orgId),
      ),
    );
  if (!version) return { kind: "forbidden", reason: "org does not own this version" };

  const fields = {
    agentId: request.agentId,
    agentVersionId: request.agentVersionId,
    lkJobId: request.lkJobId,
    lkRoomName: request.lkRoomName,
    direction: request.direction,
    fromNumber: request.fromNumber,
    toNumber: request.toNumber,
    phoneNumberId: await phoneNumberFor(db, request),
    status: request.answered ? "in_progress" : "ringing",
    answered: request.answered,
    variables: request.variables,
    campaignId: isUuid(request.campaignId) ? request.campaignId : null,
    contactId: isUuid(request.contactId) ? request.contactId : null,
    startedAt: now,
    answeredAt: request.answered ? now : null,
  } satisfies Partial<typeof calls.$inferInsert>;

  const requestId = request.requestId;
  if (isUuid(requestId)) {
    // Placed through POST /v1/calls: take over the queued row, keeping the id the client holds.
    const attached = await db.transaction(async (tx): Promise<OpenCallOutcome | null> => {
      const [queued] = await tx
        .select()
        .from(calls)
        .where(eq(calls.requestId, requestId))
        .for("update");
      if (!queued) return null;
      if (queued.orgId !== request.orgId) {
        return { kind: "forbidden", reason: "request belongs to another org" };
      }
      if (queued.status !== "queued") return null;

      const updated = await tx
        .update(calls)
        .set(fields)
        .where(eq(calls.id, queued.id))
        .returning()
        .then(onlyRow);
      return opened(updated);
    });
    if (attached) return attached;
  }

  const [inserted] = await db
    .insert(calls)
    .values({ ...fields, orgId: request.orgId })
    .onConflictDoNothing({ target: calls.lkJobId })
    .returning();
  if (inserted) return opened(inserted);

  // Lost a race with a retry of the same job: the other insert won.
  const winner = await db
    .select()
    .from(calls)
    .where(eq(calls.lkJobId, request.lkJobId))
    .then(onlyRow);
  return opened(winner);
}
