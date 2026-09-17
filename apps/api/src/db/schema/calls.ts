/**
 * Calls and their transcripts.
 *
 * These are the tables the worker writes to, through the API, while a call is
 * happening. Two constraints carry most of the weight:
 *
 * `lkJobId` is unique, so a worker that dies and has its job retried updates
 * the same row rather than creating a second one. `(callId, seq)` is unique on
 * the event table for the same reason -- a flush that is retried after a
 * network blip must not duplicate the transcript.
 *
 * Neither is an optimisation. Workers are killed by deploys and by the
 * scheduler, and a call record that silently forks is a billing error.
 */

import {
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { agents, agentVersions } from "./agents";
import { createdAt, id, orgs } from "./identity";
import { phoneNumbers } from "./telephony";

export const callDirection = pgEnum("call_direction", ["inbound", "outbound"]);

export const callStatus = pgEnum("call_status", [
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "no_answer",
  "busy",
]);

export const calls = pgTable(
  "calls",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),

    /**
     * The exact configuration this call ran on, pinned at the start. Not
     * nullable in spirit -- a call always has one -- but left nullable so that
     * archiving an old version never destroys the call history that references
     * it.
     */
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, {
      onDelete: "set null",
    }),

    lkRoomName: text("lk_room_name").notNull(),

    /** The idempotency anchor. See the file comment. */
    lkJobId: text("lk_job_id"),

    direction: callDirection("direction").notNull(),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id, {
      onDelete: "set null",
    }),

    status: callStatus("status").notNull().default("ringing"),

    /**
     * Why the call ended: a LiveKit CloseReason, a budget stage, or
     * `worker_lost` when a call was reconciled by the sweeper rather than
     * closed cleanly. Worth distinguishing -- a rise in `worker_lost` is an
     * infrastructure problem that would otherwise be invisible.
     */
    endReason: text("end_reason"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** Wall clock. What the customer sees on an invoice line. */
    durationSeconds: integer("duration_seconds"),
    /** After rounding and minimums. What they are actually charged for. */
    billableSeconds: integer("billable_seconds"),

    /**
     * Object storage keys, never URLs. A stored URL outlives its usefulness,
     * leaks through logs and support tickets, and cannot be revoked; a key is
     * signed on read with a short expiry.
     */
    recordingKey: text("recording_key"),
    transcriptKey: text("transcript_key"),

    /** What the platform paid, and what the customer is charged. */
    costInr: numeric("cost_inr", { precision: 12, scale: 6 }),
    priceInr: numeric("price_inr", { precision: 12, scale: 6 }),

    /** Carrier call id and anything else worth keeping for reconciliation. */
    metadata: jsonb("metadata").notNull().default({}),

    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("calls_lk_job_id_key").on(t.lkJobId),
    index("calls_org_started_idx").on(t.orgId, t.startedAt),
    index("calls_agent_idx").on(t.agentId),
    index("calls_status_idx").on(t.status),
    index("calls_room_idx").on(t.lkRoomName),
  ],
);

export const callEventType = pgEnum("call_event_type", [
  "user_message",
  "agent_message",
  "tool_call",
  "tool_result",
  "stage_change",
  "transfer",
  "error",
]);

/**
 * The transcript and everything else that happened during the call.
 *
 * This is the queryable copy, written incrementally so the dashboard can show
 * a call as it happens. A second, canonical copy of the full conversation is
 * written to object storage at `calls.transcriptKey` when the call ends, which
 * keeps the detail -- tool call ids, item ids -- that is not worth
 * normalising into columns here.
 */
export const callEvents = pgTable(
  "call_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    /** Per call, assigned by the worker. Makes a retried flush idempotent. */
    seq: integer("seq").notNull(),

    type: callEventType("type").notNull(),
    role: text("role"),
    content: text("content"),
    payload: jsonb("payload").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("call_events_call_seq_key").on(t.callId, t.seq),
    index("call_events_org_idx").on(t.orgId),
  ],
);
