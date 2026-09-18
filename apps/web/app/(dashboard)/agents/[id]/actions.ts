"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { SESSION_COOKIE } from "@/lib/api";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

export interface PublishState {
  error?: string;
  /** Per-field messages from the API's validation, keyed camelCase. */
  fields?: Record<string, string>;
  published?: number;
}

/**
 * Publishes a new version of an agent.
 *
 * Never an edit in place: the API writes a new version and moves the pointer,
 * so a call already running is unaffected and every past call record still
 * names the configuration that actually produced it.
 *
 * Validation errors come back per-field rather than as one string, because the
 * useful thing to show someone is which box is wrong.
 */
export async function publish(
  _previous: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const agentId = String(formData.get("agentId") ?? "");
  const instructions = String(formData.get("instructions") ?? "");
  const greeting = String(formData.get("greeting") ?? "");
  const promptMode = String(formData.get("promptMode") ?? "prepend_base_rules");

  const number = (name: string): number | undefined => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const config: Record<string, unknown> = {
    sttModel: formData.get("sttModel"),
    sttMode: formData.get("sttMode"),
    sttLanguage: formData.get("sttLanguage"),
    llmModel: formData.get("llmModel"),
    ttsModel: formData.get("ttsModel"),
    ttsSpeaker: formData.get("ttsSpeaker"),
    ttsLanguage: formData.get("ttsLanguage"),
    ttsPace: number("ttsPace"),
    budgetInr: number("budgetInr") ?? 0,
    timezone: formData.get("timezone"),
  };

  // The API rejects unknown keys, so a blank field has to be absent rather
  // than null -- it means "use the default", not "set this to nothing".
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined || value === "") delete config[key];
  }

  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/agents/${agentId}/versions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      body: JSON.stringify({ instructions, greeting, promptMode, config }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the server." };
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    fields?: Record<string, string>;
    version?: number;
  };

  if (!response.ok) {
    return { error: body.error ?? "That did not work.", fields: body.fields };
  }

  revalidatePath(`/agents/${agentId}`);
  return { published: body.version };
}
