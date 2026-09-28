/**
 * A call as customers see it, in webhooks and the public API.
 *
 * One shape for both, deliberately: an integration written against the
 * `call.ended` webhook should be able to fetch the same call later and get
 * the same fields back. Internal detail -- the LiveKit job id, the platform's
 * cost, the storage key of the recording -- is left out.
 */

import { asc, eq } from "drizzle-orm";

import type { Database } from "../db/client";
import { callEvents, calls } from "../db/schema";

type Reader = Pick<Database, "select">;
type CallRow = typeof calls.$inferSelect;

export interface TranscriptTurn {
  role: "caller" | "agent";
  text: string;
  at: string;
}

export interface CallView {
  id: string;
  direction: string;
  status: string;
  endReason: string | null;
  from: string | null;
  to: string | null;
  agentId: string | null;
  agentVersionId: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  priceInr: string | null;
  summary: string | null;
  disposition: string | null;
  fields: Record<string, unknown>;
  variables: Record<string, string>;
  campaignId: string | null;
  contactId: string | null;
  requestId: string | null;
  hasRecording: boolean;
  qa: Array<{ criterion: string; passed: boolean | null }>;
  latency: Record<string, number> | null;
  transcript?: TranscriptTurn[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function callView(call: CallRow, transcript?: TranscriptTurn[]): CallView {
  const meta = (call.metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: call.id,
    direction: call.direction,
    status: call.status,
    endReason: call.endReason,
    from: call.fromNumber,
    to: call.toNumber,
    agentId: call.agentId,
    agentVersionId: call.agentVersionId,
    startedAt: iso(call.startedAt),
    answeredAt: iso(call.answeredAt),
    endedAt: iso(call.endedAt),
    durationSeconds: call.durationSeconds,
    priceInr: call.priceInr,
    summary: call.summary,
    disposition: call.disposition,
    fields: (call.analysis as Record<string, unknown> | null) ?? {},
    variables: (meta.variables as Record<string, string> | undefined) ?? {},
    campaignId: str(meta.campaignId),
    contactId: str(meta.contactId),
    requestId: str(meta.requestId),
    hasRecording: Boolean(call.recordingKey),
    qa: (call.qa as CallView["qa"] | null) ?? [],
    latency: (call.latency as Record<string, number> | null) ?? null,
    ...(transcript ? { transcript } : {}),
  };
}

/** What was said, in order, without the tool calls and budget markers. */
export async function transcriptOf(db: Reader, callId: string): Promise<TranscriptTurn[]> {
  const rows = await db
    .select({ type: callEvents.type, content: callEvents.content, at: callEvents.at })
    .from(callEvents)
    .where(eq(callEvents.callId, callId))
    .orderBy(asc(callEvents.seq));
  return rows
    .filter((r) => (r.type === "user_message" || r.type === "agent_message") && r.content)
    .map((r) => ({
      role: r.type === "user_message" ? ("caller" as const) : ("agent" as const),
      text: r.content!,
      at: r.at.toISOString(),
    }));
}

export async function callWithTranscript(db: Reader, callId: string): Promise<CallView | null> {
  const row = (await db.select().from(calls).where(eq(calls.id, callId)).limit(1))[0];
  if (!row) return null;
  return callView(row, await transcriptOf(db, callId));
}

