import type { calls, orgs, usageRecords } from "../../db/schema";

type CallRow = typeof calls.$inferSelect;
type OrgRow = Pick<typeof orgs.$inferSelect, "externalId">;
type UsageRow = Pick<typeof usageRecords.$inferSelect, "id" | "billableSeconds" | "priceInr">;

/** A call as accounts see it: in `call.ended` and, later, `GET /v1/orgs/:externalId/calls/:id`. */
export function toPublicCall(call: CallRow, org: OrgRow, usage: UsageRow | null) {
  return {
    id: call.id,
    orgId: org.externalId,
    agentId: call.agentId,
    agentVersionId: call.agentVersionId,
    direction: call.direction,
    from: call.fromNumber,
    to: call.toNumber,
    status: call.status,
    endReason: call.endReason,
    answered: call.answered,
    /** False until the worker has finalized it; poll until true. */
    finalized: call.finalizedAt !== null,
    startedAt: call.startedAt?.toISOString() ?? null,
    answeredAt: call.answeredAt?.toISOString() ?? null,
    endedAt: call.endedAt?.toISOString() ?? null,
    durationSeconds: call.durationSeconds,
    hasRecording: call.recordingKey !== null && call.recordingDeletedAt === null,
    summary: call.summary,
    disposition: call.disposition,
    fields: call.analysisFields ?? {},
    qa: call.qa ?? [],
    variables: call.variables,
    usage: usage
      ? {
          usageRecordId: usage.id,
          billableSeconds: usage.billableSeconds,
          priceInr: Number(usage.priceInr),
        }
      : null,
  };
}

export type PublicCall = ReturnType<typeof toPublicCall>;
