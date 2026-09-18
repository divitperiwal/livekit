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
