/**
 * Talking to the control plane.
 *
 * Every read happens on the server, in a React Server Component, and forwards
 * the browser's session cookie. Two reasons that matters: the API is not
 * reachable from the public internet in a real deployment, and nothing about
 * a tenant's data passes through the client bundle except what a page chooses
 * to render.
 */

import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

export const SESSION_COOKIE = "automitra_session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Fetches from the API as the signed-in user.
 *
 * `cookies()` is async in this version of Next, and reading it opts the page
 * out of static rendering -- which is correct here, since every one of these
 * pages is per-user data that must never be cached between people.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  const response = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    let message = `request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* the status is all we have */
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

/** Whether there is a session cookie at all, for the redirect guard. */
export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  return Boolean(store.get(SESSION_COOKIE)?.value);
}

// --- what the API returns ---------------------------------------------------

export interface Me {
  email: string;
  role: "owner" | "admin" | "developer" | "viewer";
  orgId: string;
  organisations: Array<{ id: string; name: string; slug: string; role: string }>;
}

export interface CallSummary {
  id: string;
  agentId: string | null;
  agentSlug: string | null;
  direction: "inbound" | "outbound";
  fromNumber: string | null;
  toNumber: string | null;
  status: string;
  endReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  costInr: string | null;
  priceInr: string | null;
  recordingKey: string | null;
  summary?: string | null;
  disposition?: string | null;
  analysis?: Record<string, unknown> | null;
  qa?: Array<{ criterion: string; passed: boolean | null }> | null;
  latency?: { turns: number; p50: number; p95: number; max: number; eou: number; llm: number; tts: number } | null;
}

export interface CallEvent {
  id: string;
  seq: number;
  type: string;
  role: string | null;
  content: string | null;
  payload: Record<string, unknown>;
  at: string;
}

export interface UsageRecord {
  billableSeconds: number;
  sttSeconds: string;
  ttsCharacters: number;
  llmPromptTokens: number;
  llmCachedTokens: number;
  llmCompletionTokens: number;
  costTotalInr: string | null;
  priceInr: string | null;
  needsReview: boolean;
  reviewReason: string | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  liveVersionId: string | null;
  candidateVersionId?: string | null;
  candidatePercent?: number;
  updatedAt: string;
}

export interface AgentVersion {
  id: string;
  version: number;
  promptMode: "prepend_base_rules" | "verbatim";
  instructions: string;
  greeting: string;
  config: Record<string, unknown>;
  publishedAt: string | null;
}

export interface PhoneNumber {
  id: string;
  e164: string;
  provider: string;
  direction: string;
  status: string;
  agentId: string | null;
  agentSlug: string | null;
}

export interface Usage {
  balanceInr: number;
  creditLimitInr: number;
  canPlaceCalls: boolean;
  daily: Array<{
    day: string;
    calls: number;
    seconds: number;
    costInr: string;
    priceInr: string;
  }>;
  needsReview: number;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  headers: Record<string, string>;
  authType: "none" | "bearer" | "header" | "hmac";
  authHeader: string | null;
  /** Whether a secret is stored. The secret itself is never sent back. */
  hasSecret: boolean;
  timeoutMs: number;
  responseTemplate: string | null;
  isSlow: boolean;
  enabled: boolean;
}

export type ContactStatus = "pending" | "dialing" | "completed" | "failed" | "exhausted" | "suppressed";

export interface CallingWindow {
  days: number[];
  start: string;
  end: string;
}

export interface Campaign {
  id: string;
  name: string;
  agentId: string;
  status: "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled";
  statusReason: string | null;
  fromNumberId: string | null;
  schedule: { timezone: string; windows: CallingWindow[] };
  concurrency: number;
  retryPolicy: { maxAttempts: number; retryAfterMinutes: number[]; retryOn: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface CampaignContact {
  id: string;
  e164: string;
  variables: Record<string, string>;
  status: ContactStatus;
  attempts: number;
  lastCallId: string | null;
  lastOutcome: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  updatedAt: string;
}

export interface Suppression {
  id: string;
  e164: string;
  source: string;
  reason: string | null;
  callId: string | null;
  createdAt: string;
}

export interface Settings {
  redactPii: boolean;
  recordCalls: boolean;
  recordingRetentionDays: number;
  recordingStorageConfigured: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  display: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  eventKey: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  documents?: number;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  sourceType: "text" | "url";
  sourceUrl: string | null;
  chars: number;
  chunkCount: number;
  createdAt: string;
}

export interface Analytics {
  period: { days: number };
  totals: {
    calls: number;
    inbound: number;
    outbound: number;
    outboundAnswered: number;
    answerRate: number | null;
    voicemail: number;
    completed: number;
    transferred: number;
    avgDurationSeconds: number;
    priceInr: number;
    costInr: number;
    latencyP50: number | null;
    latencyP95: number | null;
  };
  dispositions: Array<{ disposition: string; calls: number }>;
  endReasons: Array<{ status: string; endReason: string | null; calls: number }>;
  daily: Array<{ day: string; calls: number; answered: number }>;
  versions: Array<{
    agentVersionId: string | null;
    version: number | null;
    calls: number;
    answered: number;
    avgDurationSeconds: number;
    latencyP50: number | null;
    qaPassRate: number | null;
    dispositions: Record<string, number> | null;
  }>;
}

export interface Scenario {
  id: string;
  name: string;
  caller: string;
  criteria: string[];
  maxTurns: number;
  variables: Record<string, string>;
  toolResponses: Record<string, string>;
}

export interface EvalRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  version: number | null;
  passed: number | null;
  total: number | null;
  tokens: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface EvalResult {
  id: string;
  scenarioName: string;
  passed: boolean;
  transcript: Array<{ role: string; text: string }>;
  judgments: Array<{ criterion: string; passed: boolean; reasoning: string }>;
  turns: number;
  error: string | null;
}

export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "developer" | "viewer";
  joinedAt: string;
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}
