/**
 * Call records, written by the worker as a call happens.
 *
 * Every write here is idempotent, because the worker cannot promise to call
 * any of them exactly once. Jobs are retried when a worker is killed mid-call,
 * a session's close handler and its shutdown callback can both fire, and
 * webhooks get redelivered. A forked call record is a billing error; a
 * duplicated usage record charges someone twice.
 */

import { and, eq, sql as raw } from "drizzle-orm";

import type { Database } from "../db/client";
import { callEvents, calls, campaignContacts, orgs, suppressedNumbers, usageRecords } from "../db/schema";
import { post } from "./ledger";
import { callView, transcriptOf } from "./call-view";
import { priceCall, rateCardFor } from "./pricing";
import { redact } from "./redact";
import { enqueue } from "./webhooks";

const E164 = /^\+[1-9][0-9]{6,14}$/;

// Checked before a contact id reaches a query. A malformed one would fail the
// whole insert, and losing the call record over a bad link is the wrong trade.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StartCallInput {
  orgId: string;
  agentId: string;
  agentVersionId: string;
  lkRoomName: string;
  lkJobId: string;
  direction: "inbound" | "outbound";
  fromNumber?: string | null;
  toNumber?: string | null;
  phoneNumberId?: string | null;
  /** False for an outbound attempt nobody picked up. Defaults to true. */
  answered?: boolean;
  /** The values filled into the prompt, kept so a call can be explained later. */
  variables?: Record<string, string> | null;
  /** The campaign contact this call is an attempt at, when the dialer placed it. */
  campaignId?: string | null;
  contactId?: string | null;
  /** The public API request this call came from, so the caller can find it. */
  requestId?: string | null;
}

/**
 * Opens a call record, or returns the existing one.
 *
 * Keyed on the LiveKit job id, so a retried job continues the same record
 * rather than starting a second one. The update on conflict is deliberately
 * narrow: the room can change on a retry, but the pinned agent version must
 * not, or the call would be billed against a configuration it never ran.
 *
 * A dialer call also points its contact at this record, which is how the
 * dialer later finds out how the attempt went. Scoped by organisation as well
 * as by id, so a job whose metadata named another tenant's contact links
 * nothing.
 */
export async function startCall(db: Database, input: StartCallInput) {
  const now = new Date();
  const metadata: Record<string, unknown> = {};
  if (input.variables && Object.keys(input.variables).length > 0) metadata.variables = input.variables;
  if (input.campaignId) metadata.campaignId = input.campaignId;
  if (input.contactId) metadata.contactId = input.contactId;
  if (input.requestId) metadata.requestId = input.requestId;

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(calls)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        agentVersionId: input.agentVersionId,
        lkRoomName: input.lkRoomName,
        lkJobId: input.lkJobId,
        direction: input.direction,
        fromNumber: input.fromNumber ?? null,
        toNumber: input.toNumber ?? null,
        phoneNumberId: input.phoneNumberId ?? null,
        status: "in_progress",
        startedAt: now,
        answeredAt: input.answered === false ? null : now,
        metadata,
      })
      .onConflictDoUpdate({
        target: calls.lkJobId,
        set: { lkRoomName: input.lkRoomName },
      })
      .returning();

    const call = rows[0]!;

    if (input.contactId && UUID.test(input.contactId)) {
      await tx
        .update(campaignContacts)
        .set({ lastCallId: call.id, updatedAt: now })
        .where(
          and(
            eq(campaignContacts.id, input.contactId),
            eq(campaignContacts.orgId, call.orgId),
            eq(campaignContacts.status, "dialing"),
          ),
        );
    }

    return call;
  });
}

export interface CallEventInput {
  seq: number;
  type:
    | "user_message"
    | "agent_message"
    | "tool_call"
    | "tool_result"
    | "stage_change"
    | "transfer"
    | "error"
    | "amd";
  role?: string | null;
  content?: string | null;
  payload?: unknown;
  at: string;
}

/**
 * Appends transcript turns and other events.
 *
 * `seq` is assigned by the worker and unique per call, so a flush that is
 * retried after a network blip inserts nothing the second time rather than
 * duplicating the conversation.
 */
export async function appendEvents(
  db: Database,
  callId: string,
  orgId: string,
  events: CallEventInput[],
): Promise<number> {
  if (events.length === 0) return 0;

  // Masked before the insert, for an organisation that asked, so the
  // unmasked text is never stored. Tool arguments too: an agent passing the
  // caller's number to a CRM puts it in the transcript that way.
  const masking = await redactsPii(db, orgId);
  const mask = (text: string | null | undefined) => (text && masking ? redact(text) : (text ?? null));

  const inserted = await db
    .insert(callEvents)
    .values(
      events.map((event) => {
        const payload = { ...((event.payload ?? {}) as Record<string, unknown>) };
        if (masking && typeof payload.arguments === "string") payload.arguments = redact(payload.arguments);
        return {
          callId,
          orgId,
          seq: event.seq,
          type: event.type,
          role: event.role ?? null,
          content: mask(event.content),
          payload,
          at: new Date(event.at),
        };
      }),
    )
    .onConflictDoNothing({ target: [callEvents.callId, callEvents.seq] })
    .returning({ seq: callEvents.seq });

  return inserted.length;
}

async function redactsPii(db: Pick<Database, "select">, orgId: string): Promise<boolean> {
  const row = (await db.select({ redact: orgs.redactPii }).from(orgs).where(eq(orgs.id, orgId)).limit(1))[0];
  return row?.redact ?? false;
}

export interface FinalizeInput {
  status: "completed" | "failed" | "no_answer" | "busy" | "voicemail";
  endReason?: string | null;
  durationSeconds?: number | null;
  billableSeconds?: number | null;
  transcriptKey?: string | null;
  /** The caller asked, on the call, not to be called again. */
  doNotCall?: boolean;
  /** Where the recording was written, when the call was recorded. */
  recordingKey?: string | null;
  /** What the post-call analysis made of it. */
  analysis?: {
    summary?: string | null;
    disposition?: string | null;
    fields?: Record<string, unknown>;
    qa?: Array<{ criterion: string; passed: boolean | null }>;
  };
  /** How long the caller waited for replies; see `calls.latency`. */
  latency?: Record<string, number> | null;
  /**
   * What the call measurably used.
   *
   * Deliberately raw: the worker reports what it observed and the control
   * plane prices it. Rate cards, minimums and margin live here, so a pricing
   * change is a deploy of one service rather than of the whole fleet -- and a
   * worker running an older build cannot quietly bill at last month's rates.
   */
  usage?: {
    sttSeconds: number;
    ttsCharacters: number;
    llmPromptTokens: number;
    llmCachedTokens: number;
    llmCompletionTokens: number;
    /** Which models actually ran, so the right rates are applied. */
    sttModel?: string | null;
    ttsModel?: string | null;
    llmModel?: string | null;
  };
}

/**
 * Closes a call and records what it used.
 *
 * Safe to call more than once. The call row is updated -- a second finalize
 * with better numbers is an improvement, not a duplicate -- while the usage
 * record is inserted once and left alone, because that is the row money is
 * computed from.
 */
export async function finalizeCall(
  db: Database,
  callId: string,
  input: FinalizeInput,
) {
  // Read the card before the transaction: it is not part of what has to be
  // atomic, and holding a transaction open across an extra query is needless.
  const existing = await db
    .select({
      orgId: calls.orgId,
      toNumber: calls.toNumber,
      fromNumber: calls.fromNumber,
      direction: calls.direction,
    })
    .from(calls)
    .where(eq(calls.id, callId))
    .limit(1);
  const known = existing[0];
  if (!known) {
    throw new Error(`call ${callId} not found`);
  }

  const card = input.usage ? await rateCardFor(db, known.orgId) : null;
  const priced =
    input.usage && card !== undefined
      ? priceCall(
          {
            ...input.usage,
            durationSeconds: input.durationSeconds ?? 0,
            toNumber: known.toNumber,
            // A browser test call has no number at either end.
            phoneLeg: Boolean(known.toNumber || known.fromNumber),
          },
          card,
        )
      : null;

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(calls)
      .set({
        status: input.status,
        endReason: input.endReason ?? null,
        endedAt: new Date(),
        durationSeconds: input.durationSeconds ?? null,
        billableSeconds: priced?.billableSeconds ?? input.billableSeconds ?? null,
        transcriptKey: input.transcriptKey ?? null,
        // Left alone when absent rather than cleared: a second finalize that
        // knows less must not erase what the first one wrote.
        recordingKey: typeof input.recordingKey === "string" ? input.recordingKey : undefined,
        ...analysisColumns(input.analysis, await redactsPii(db, known.orgId)),
        latency: input.latency && typeof input.latency === "object" ? input.latency : undefined,
        costInr: priced?.costTotalInr?.toString() ?? null,
        priceInr: priced?.priceInr?.toString() ?? null,
      })
      .where(eq(calls.id, callId))
      .returning();

    const call = updated[0]!;

    // The far end's number: whoever was called, or whoever called in. A
    // browser test call has none, and there is nothing to suppress.
    const farEnd = known.direction === "outbound" ? known.toNumber : known.fromNumber;
    if (input.doNotCall && farEnd && E164.test(farEnd)) {
      await tx
        .insert(suppressedNumbers)
        .values({
          orgId: call.orgId,
          e164: farEnd,
          source: "call",
          reason: "asked on a call not to be called again",
          callId: call.id,
        })
        .onConflictDoNothing({ target: [suppressedNumbers.orgId, suppressedNumbers.e164] });
    }

    if (input.usage && priced) {
      const inserted = await tx
        .insert(usageRecords)
        .values({
          orgId: call.orgId,
          callId: call.id,
          idempotencyKey: `call:${call.id}:v1`,
          periodStart: new Date().toISOString().slice(0, 10),
          billableSeconds: priced.billableSeconds,
          sttSeconds: input.usage.sttSeconds.toString(),
          ttsCharacters: input.usage.ttsCharacters,
          llmPromptTokens: input.usage.llmPromptTokens,
          llmCachedTokens: input.usage.llmCachedTokens,
          llmCompletionTokens: input.usage.llmCompletionTokens,
          pstnSeconds: priced.billableSeconds,
          costSttInr: priced.costSttInr?.toString() ?? null,
          costTtsInr: priced.costTtsInr?.toString() ?? null,
          costLlmInr: priced.costLlmInr?.toString() ?? null,
          costPstnInr: priced.costPstnInr?.toString() ?? null,
          costTotalInr: priced.costTotalInr?.toString() ?? null,
          priceInr: priced.priceInr?.toString() ?? null,
          rateCardId: priced.rateCardId,
          needsReview: priced.needsReview,
          reviewReason: priced.reviewReason,
        })
        .onConflictDoNothing({ target: usageRecords.idempotencyKey })
        .returning({ id: usageRecords.id });

      // Only charge when the usage record was newly written. A second
      // finalize -- the close handler and the shutdown callback both firing,
      // or a redelivered webhook -- must not debit the balance twice.
      const record = inserted[0];
      if (record && priced.priceInr !== null && priced.priceInr > 0) {
        await post(tx, {
          orgId: call.orgId,
          kind: "usage",
          amountInr: -priced.priceInr,
          idempotencyKey: `call:${call.id}:v1`,
          usageRecordId: record.id,
          description: `call ${call.id}`,
        });
      }
    }

    // In the same transaction as the call it reports, so an event is never
    // sent for a call that rolled back, nor a call finalised without one.
    await enqueue(tx, call.orgId, "call.ended", `call.ended:${call.id}`, callView(call, await transcriptOf(tx, call.id)));

    return call;
  });
}

/**
 * The analysis as columns, checked for shape only.
 *
 * The worker has already held it to the agent's own dispositions and field
 * types; this only stops something malformed or oversized from being stored.
 */
function analysisColumns(analysis: FinalizeInput["analysis"], masking: boolean) {
  if (!analysis || typeof analysis !== "object") return {};
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.slice(0, max) : null);
  const fields =
    analysis.fields && typeof analysis.fields === "object" && !Array.isArray(analysis.fields) ? analysis.fields : {};
  const summary = text(analysis.summary, 2000);
  const qa = Array.isArray(analysis.qa)
    ? analysis.qa
        .filter((q) => q && typeof q.criterion === "string")
        .slice(0, 20)
        .map((q) => ({ criterion: q.criterion.slice(0, 200), passed: typeof q.passed === "boolean" ? q.passed : null }))
    : null;
  return {
    summary: summary && masking ? redact(summary) : summary,
    disposition: text(analysis.disposition, 60),
    analysis: JSON.stringify(fields).length <= 20_000 ? fields : {},
    qa: qa && qa.length > 0 ? qa : null,
  };
}

/**
 * Closes calls a worker never finished.
 *
 * Workers are killed by deploys and by the scheduler. Without this their calls
 * sit at `in_progress` forever and never produce a usage record -- revenue
 * that disappears silently and is invisible in any dashboard, because the row
 * looks like a call still in progress rather than a failure.
 */
export async function sweepStaleCalls(db: Database, olderThanSeconds = 7200) {
  return db.transaction(async (tx) => {
    const swept = await tx
      .update(calls)
      .set({ status: "failed", endReason: "worker_lost", endedAt: new Date() })
      .where(
        and(
          eq(calls.status, "in_progress"),
          raw`${calls.startedAt} < now() - make_interval(secs => ${olderThanSeconds})`,
        ),
      )
      .returning();

    // A customer's integration is waiting for these calls to end like any
    // other, and would otherwise wait forever.
    for (const call of swept) {
      await enqueue(tx, call.orgId, "call.ended", `call.ended:${call.id}`, callView(call, await transcriptOf(tx, call.id)));
    }
    return swept.length;
  });
}
