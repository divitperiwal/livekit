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
import { callEvents, calls, usageRecords } from "../db/schema";
import { post } from "./ledger";
import { priceCall, rateCardFor } from "./pricing";

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
}

/**
 * Opens a call record, or returns the existing one.
 *
 * Keyed on the LiveKit job id, so a retried job continues the same record
 * rather than starting a second one. The update on conflict is deliberately
 * narrow: the room can change on a retry, but the pinned agent version must
 * not, or the call would be billed against a configuration it never ran.
 */
export async function startCall(db: Database, input: StartCallInput) {
  const rows = await db
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
      startedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: calls.lkJobId,
      set: { lkRoomName: input.lkRoomName },
    })
    .returning();

  return rows[0]!;
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
    | "error";
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

  const inserted = await db
    .insert(callEvents)
    .values(
      events.map((event) => ({
        callId,
        orgId,
        seq: event.seq,
        type: event.type,
        role: event.role ?? null,
        content: event.content ?? null,
        payload: (event.payload ?? {}) as object,
        at: new Date(event.at),
      })),
    )
    .onConflictDoNothing({ target: [callEvents.callId, callEvents.seq] })
    .returning({ seq: callEvents.seq });

  return inserted.length;
}

export interface FinalizeInput {
  status: "completed" | "failed" | "no_answer" | "busy";
  endReason?: string | null;
  durationSeconds?: number | null;
  billableSeconds?: number | null;
  transcriptKey?: string | null;
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
    .select({ orgId: calls.orgId, toNumber: calls.toNumber })
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
        costInr: priced?.costTotalInr?.toString() ?? null,
        priceInr: priced?.priceInr?.toString() ?? null,
      })
      .where(eq(calls.id, callId))
      .returning();

    const call = updated[0]!;

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

    return call;
  });
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
  const swept = await db
    .update(calls)
    .set({ status: "failed", endReason: "worker_lost", endedAt: new Date() })
    .where(
      and(
        eq(calls.status, "in_progress"),
        raw`${calls.startedAt} < now() - make_interval(secs => ${olderThanSeconds})`,
      ),
    )
    .returning({ id: calls.id });

  return swept.length;
}
