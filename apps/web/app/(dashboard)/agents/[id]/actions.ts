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
    sttRealtime: formData.get("sttRealtime") === "on",
    llmModel: formData.get("llmModel"),
    ttsModel: formData.get("ttsModel"),
    ttsSpeaker: formData.get("ttsSpeaker"),
    ttsLanguage: formData.get("ttsLanguage"),
    ttsPace: number("ttsPace"),
    budgetInr: number("budgetInr") ?? 0,
    // Blank is the platform ceiling (0), not "no limit": there is no such option.
    maxInrPerMin: number("maxInrPerMin") ?? 0,
    timezone: formData.get("timezone"),
    // An unticked box is absent from the form, which here means false.
    endCallEnabled: formData.get("endCallEnabled") === "on",
    voicemailDetection: formData.get("voicemailDetection") === "on",
    voicemailAction: formData.get("voicemailAction"),
    voicemailMessage: formData.get("voicemailMessage"),
    greetingMode: formData.get("greetingVerbatim") === "on" ? "verbatim" : "instructions",
    recordingNotice: String(formData.get("recordingNotice") ?? "").trim(),
  };

  // Blank rows are someone who clicked "add" and changed their mind, not a
  // target with no number.
  try {
    const rows = JSON.parse(String(formData.get("transferTargets") ?? "[]")) as Array<{
      name: string;
      number: string;
      description: string;
    }>;
    config.transferTargets = rows
      .map((row) => ({
        name: row.name.trim(),
        number: row.number.replace(/[\s-]/g, ""),
        description: row.description.trim(),
      }))
      .filter((row) => row.name || row.number);
  } catch {
    return { error: "The transfer numbers could not be read." };
  }

  // Hours go as numbers, or as whatever was typed when that is not one, so the
  // API names the bad row rather than this quietly dropping it.
  try {
    const rows = JSON.parse(String(formData.get("closingLines") ?? "[]")) as Array<{
      start: string;
      end: string;
      text: string;
    }>;
    const hour = (raw: string): number | string => {
      const value = Number(raw.trim());
      return raw.trim() !== "" && Number.isInteger(value) ? value : raw;
    };
    config.closingLines = rows
      .filter((row) => row.start.trim() || row.end.trim() || row.text.trim())
      .map((row) => ({ start: hour(row.start), end: hour(row.end), text: row.text.trim() }));
  } catch {
    return { error: "The closing lines could not be read." };
  }

  config.analysisEnabled = formData.get("analysisEnabled") === "on";
  config.qaCriteria = String(formData.get("qaCriteria") ?? "")
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);
  config.dtmfInput = formData.get("dtmfInput") === "on";
  const silenceTimeout = number("silenceTimeout");
  const silenceChecks = number("silenceChecks");
  if (silenceTimeout !== undefined) config.silenceTimeout = silenceTimeout;
  if (silenceChecks !== undefined) config.silenceChecks = silenceChecks;
  // An empty choice is "no fallback": sent as null, which the schema takes
  // as the default, rather than dropped and left at whatever it was.
  for (const name of ["fallbackLlm", "fallbackStt", "fallbackTts"]) {
    config[name] = String(formData.get(name) ?? "") || null;
  }
  config.fallbackTtsVoice = String(formData.get("fallbackTtsVoice") ?? "").trim();
  config.dispositions = String(formData.get("dispositions") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  try {
    const rows = JSON.parse(String(formData.get("analysisFields") ?? "[]")) as Array<{
      name: string;
      type: string;
      description: string;
      options: string;
    }>;
    config.analysisFields = rows
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        type: row.type,
        ...(row.type === "enum"
          ? { options: row.options.split(",").map((o) => o.trim()).filter(Boolean) }
          : { description: row.description.trim() }),
      }));
  } catch {
    return { error: "The analysis fields could not be read." };
  }

  const toolIds = formData.getAll("toolIds").map(String);
  const knowledgeBaseIds = formData.getAll("knowledgeBaseIds").map(String);

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
      body: JSON.stringify({ instructions, greeting, promptMode, config, toolIds, knowledgeBaseIds }),
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

export interface TestCallResult {
  url: string;
  token: string;
  roomName: string;
  agentSlug: string;
}

/**
 * Asks the API for a room and a token, and puts the agent in it.
 *
 * The token is minted server-side and never leaves this request except to the
 * browser that asked for it: it grants publish and subscribe on one room and
 * expires in minutes.
 */
export async function startTestCall(
  agentId: string,
): Promise<TestCallResult | { error: string }> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  try {
    const response = await fetch(`${API_URL}/api/agents/${agentId}/test-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      cache: "no-store",
    });

    const body = (await response.json().catch(() => ({}))) as
      | TestCallResult
      | { error?: string };

    if (!response.ok) {
      return { error: ("error" in body && body.error) || "Could not start the call." };
    }
    return body as TestCallResult;
  } catch {
    return { error: "Could not reach the server." };
  }
}
