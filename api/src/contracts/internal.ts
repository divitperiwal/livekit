/**
 * The `/internal/*` contract, as Zod. The worker's `control_plane/contract.py` is the
 * source and exports `schema/internal-api.schema.json`; a test fails if these drift from it.
 *
 *   GET  /internal/resolve                 -> ResolveResponse   (402, 403, 404 -> ErrorResponse)
 *   POST /internal/calls                   OpenCallRequest      -> OpenCallResponse
 *   POST /internal/calls/{id}/events       AppendEventsRequest  -> AppendEventsResponse
 *   POST /internal/calls/{id}/finalize     FinalizeCallRequest  -> FinalizeCallResponse
 */
import { z } from "zod";

export const INTERNAL_SECRET_HEADER = "x-internal-secret";

export const callDirectionSchema = z.enum(["inbound", "outbound"]);
export const callStatusSchema = z.enum([
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "no_answer",
  "busy",
  "voicemail",
]);
export const callEventTypeSchema = z.enum([
  "user_message",
  "agent_message",
  "tool_call",
  "tool_result",
  "stage_change",
  "transfer",
  "error",
  "amd",
]);

const nullableString = () => z.string().nullable().default(null);

export const errorResponseSchema = z.object({ error: z.string() });

export const resolveResponseSchema = z.object({
  orgId: z.string(),
  agentId: z.string(),
  agentVersionId: z.string(),
  agentSlug: z.string(),
  promptMode: z.enum(["prepend_base_rules", "verbatim"]),
  instructions: z.string().min(1),
  greeting: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  recordCalls: z.boolean().default(false),
  availableInr: z.number().nullable().default(null),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  knowledgeBaseCount: z.number().int().default(0),
});

export const openCallRequestSchema = z.object({
  orgId: z.string(),
  agentId: z.string(),
  agentVersionId: z.string(),
  lkRoomName: z.string(),
  lkJobId: z.string(),
  direction: callDirectionSchema,
  fromNumber: nullableString(),
  toNumber: nullableString(),
  phoneNumberId: nullableString(),
  answered: z.boolean().default(true),
  variables: z.record(z.string(), z.string()).default({}),
  campaignId: nullableString(),
  contactId: nullableString(),
  requestId: nullableString(),
});

export const openCallResponseSchema = z.object({ id: z.string(), orgId: z.string() });

export const callEventSchema = z.object({
  seq: z.number().int().min(1),
  type: callEventTypeSchema,
  role: z.enum(["user", "assistant", "tool"]).nullable().default(null),
  content: nullableString(),
  payload: z.record(z.string(), z.unknown()).default({}),
  at: z.string(),
});

export const appendEventsRequestSchema = z.object({
  orgId: z.string(),
  events: z.array(callEventSchema).min(1),
});

export const appendEventsResponseSchema = z.object({ inserted: z.number().int() });

export const latencySummarySchema = z.object({
  turns: z.number().int(),
  p50: z.number(),
  p95: z.number(),
  max: z.number(),
  eou: z.number(),
  llm: z.number(),
  tts: z.number(),
  dominant: z.enum(["eou", "llm", "tts"]),
});

export const usageReportSchema = z.object({
  sttSeconds: z.number(),
  ttsCharacters: z.number().int(),
  llmPromptTokens: z.number().int(),
  llmCachedTokens: z.number().int(),
  llmCompletionTokens: z.number().int(),
  sttModel: z.string(),
  ttsModel: z.string(),
  llmModel: z.string(),
});

export const qaVerdictSchema = z.object({
  criterion: z.string(),
  /** Null: the model gave no clear answer. */
  passed: z.boolean().nullable(),
});

export const callAnalysisSchema = z.object({
  summary: z.string().max(1000).nullable().default(null),
  disposition: nullableString(),
  fields: z.record(z.string(), z.unknown()).default({}),
  qa: z.array(qaVerdictSchema).default([]),
});

export const finalizeCallRequestSchema = z.object({
  status: callStatusSchema,
  endReason: nullableString(),
  durationSeconds: z.number().int().min(0),
  doNotCall: z.boolean().default(false),
  recordingKey: nullableString(),
  latency: latencySummarySchema.nullable().default(null),
  analysis: callAnalysisSchema.nullable().default(null),
  usage: usageReportSchema.nullable().default(null),
});

export const finalizeCallResponseSchema = z.object({ id: z.string(), status: callStatusSchema });

/** Keyed by the `$defs` names in `schema/internal-api.schema.json`. */
export const internalContract = {
  AppendEventsRequest: appendEventsRequestSchema,
  AppendEventsResponse: appendEventsResponseSchema,
  CallAnalysis: callAnalysisSchema,
  CallEvent: callEventSchema,
  ErrorResponse: errorResponseSchema,
  FinalizeCallRequest: finalizeCallRequestSchema,
  FinalizeCallResponse: finalizeCallResponseSchema,
  LatencySummary: latencySummarySchema,
  OpenCallRequest: openCallRequestSchema,
  OpenCallResponse: openCallResponseSchema,
  QaVerdict: qaVerdictSchema,
  ResolveResponse: resolveResponseSchema,
  UsageReport: usageReportSchema,
} as const;

export type CallStatus = z.infer<typeof callStatusSchema>;
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;
export type OpenCallRequest = z.infer<typeof openCallRequestSchema>;
export type OpenCallResponse = z.infer<typeof openCallResponseSchema>;
export type CallEvent = z.infer<typeof callEventSchema>;
export type AppendEventsRequest = z.infer<typeof appendEventsRequestSchema>;
export type FinalizeCallRequest = z.infer<typeof finalizeCallRequestSchema>;
export type FinalizeCallResponse = z.infer<typeof finalizeCallResponseSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;
export type CallAnalysis = z.infer<typeof callAnalysisSchema>;
