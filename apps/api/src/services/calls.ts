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
  /** Measured usage, for the usage record. */
  usage?: {
    sttSeconds: number;
    ttsCharacters: number;
    llmPromptTokens: number;
    llmCachedTokens: number;
    llmCompletionTokens: number;
    costInr?: number | null;
    priceInr?: number | null;
    needsReview?: boolean;
    reviewReason?: string | null;
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
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(calls)
      .set({
        status: input.status,
        endReason: input.endReason ?? null,
        endedAt: new Date(),
        durationSeconds: input.durationSeconds ?? null,
        billableSeconds: input.billableSeconds ?? null,
        transcriptKey: input.transcriptKey ?? null,
        costInr: input.usage?.costInr?.toString() ?? null,
        priceInr: input.usage?.priceInr?.toString() ?? null,
      })
      .where(eq(calls.id, callId))
      .returning();

    const call = updated[0];
    if (!call) {
      throw new Error(`call ${callId} not found`);
    }

    if (input.usage) {
      await tx
        .insert(usageRecords)
        .values({
          orgId: call.orgId,
          callId: call.id,
          idempotencyKey: `call:${call.id}:v1`,
          periodStart: new Date().toISOString().slice(0, 10),
          billableSeconds: input.billableSeconds ?? 0,
          sttSeconds: input.usage.sttSeconds.toString(),
          ttsCharacters: input.usage.ttsCharacters,
          llmPromptTokens: input.usage.llmPromptTokens,
          llmCachedTokens: input.usage.llmCachedTokens,
          llmCompletionTokens: input.usage.llmCompletionTokens,
          costTotalInr: input.usage.costInr?.toString() ?? null,
          priceInr: input.usage.priceInr?.toString() ?? null,
          needsReview: input.usage.needsReview ?? false,
          reviewReason: input.usage.reviewReason ?? null,
        })
        .onConflictDoNothing({ target: usageRecords.idempotencyKey });
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
