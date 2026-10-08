import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, agentVersions } from "./agents";
import { at, createdAt, id, updatedAt } from "./columns";
import { apiKeys, orgs } from "./tenancy";

export const numberProvider = pgEnum("number_provider", ["plivo"]);
export const numberDirection = pgEnum("number_direction", ["inbound", "outbound", "both"]);
export const numberStatus = pgEnum("number_status", ["available", "assigned", "releasing"]);

/** Org null = in our pool. The org-deletion job returns its numbers to the pool. */
export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: id(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "restrict" }),
    e164: text("e164").notNull().unique(),
    provider: numberProvider("provider").notNull().default("plivo"),
    direction: numberDirection("direction").notNull().default("both"),
    status: numberStatus("status").notNull().default("available"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    lkDispatchRuleId: text("lk_dispatch_rule_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("phone_numbers_org_idx").on(t.orgId),
    check("phone_numbers_pool_has_no_agent", sql`${t.orgId} is not null or ${t.agentId} is null`),
  ],
);

/** `queued`: created by `POST /v1/calls` before any worker has the job. The rest come from the worker. */
export const callStatus = pgEnum("call_status", [
  "queued",
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "no_answer",
  "busy",
  "voicemail",
]);
/** Statuses that hold one of the placing key's concurrency slots. */
export const liveCallStatuses = ["queued", "ringing", "in_progress"] as const;

export const callDirection = pgEnum("call_direction", ["inbound", "outbound"]);

/**
 * One record per LiveKit job, pinned to the exact version that ran (guarantee 16).
 * Opened idempotently on `lk_job_id`; an API-placed call is created first and the
 * worker's open attaches to it through `request_id`.
 */
export const calls = pgTable(
  "calls",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    requestId: uuid("request_id").unique(),
    /** The key that placed the call through `/v1`; null for inbound and dev calls. */
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "restrict" }),
    lkJobId: text("lk_job_id").unique(),
    lkRoomName: text("lk_room_name"),
    direction: callDirection("direction").notNull(),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id, {
      onDelete: "set null",
    }),
    status: callStatus("status").notNull(),
    endReason: text("end_reason"),
    answered: boolean("answered").notNull().default(false),
    variables: jsonb("variables").$type<Record<string, string>>().notNull().default({}),
    /** No foreign keys until campaigns are confirmed for v1. */
    campaignId: uuid("campaign_id"),
    contactId: uuid("contact_id"),
    startedAt: at("started_at"),
    answeredAt: at("answered_at"),
    endedAt: at("ended_at"),
    finalizedAt: at("finalized_at"),
    durationSeconds: integer("duration_seconds"),
    /** Stored only after the upload succeeded (guarantee 20). */
    recordingKey: text("recording_key"),
    recordingDeletedAt: at("recording_deleted_at"),
    summary: text("summary"),
    disposition: text("disposition"),
    analysisFields: jsonb("analysis_fields").$type<Record<string, unknown>>(),
    qa: jsonb("qa").$type<{ criterion: string; passed: boolean | null }[]>(),
    latency: jsonb("latency").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "calls_agent_fk",
      columns: [t.agentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
    }).onDelete("restrict"),
    foreignKey({
      name: "calls_agent_version_fk",
      columns: [t.agentVersionId, t.orgId],
      foreignColumns: [agentVersions.id, agentVersions.orgId],
    }).onDelete("restrict"),
    foreignKey({ name: "calls_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }).onDelete(
      "restrict",
    ),
    index("calls_org_created_idx").on(t.orgId, t.createdAt.desc()),
    index("calls_live_by_api_key_idx")
      .on(t.apiKeyId)
      .where(sql`${t.status} in ('queued', 'ringing', 'in_progress')`),
    index("calls_org_disposition_idx").on(t.orgId, t.disposition),
    index("calls_recording_retention_idx")
      .on(t.endedAt)
      .where(sql`${t.recordingKey} is not null and ${t.recordingDeletedAt} is null`),
    check(
      "calls_duration_nonnegative",
      sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
    ),
    // Only a call no worker ever took (still queued, or failed before dispatch) lacks a job.
    check(
      "calls_opened_has_job",
      sql`${t.status} in ('queued', 'failed') or ${t.lkJobId} is not null`,
    ),
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
  "amd",
]);
export const callEventRole = pgEnum("call_event_role", ["user", "assistant", "tool"]);

/** The worker assigns `seq`, so a retried batch inserts nothing twice (guarantee 9). */
export const callEvents = pgTable(
  "call_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: callEventType("type").notNull(),
    role: callEventRole("role"),
    content: text("content"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    at: at("at").notNull(),
  },
  (t) => [
    unique("call_events_call_seq_key").on(t.callId, t.seq),
    check("call_events_seq_positive", sql`${t.seq} > 0`),
  ],
);

export const suppressionSource = pgEnum("suppression_source", [
  "caller_request",
  "api",
  "operator",
]);

/** Do-not-call list per org. Survives erasure of the call that added it. */
export const suppressedNumbers = pgTable(
  "suppressed_numbers",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "restrict" }),
    e164: text("e164").notNull(),
    source: suppressionSource("source").notNull(),
    reason: text("reason"),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("suppressed_numbers_org_e164_key").on(t.orgId, t.e164)],
);
