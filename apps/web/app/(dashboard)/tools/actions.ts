"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Tool } from "@/lib/api";
import { mutate } from "@/lib/mutate";

export interface ToolFormState {
  error?: string;
  fields?: Record<string, string>;
}

/** Parses a JSON box, reporting which box was wrong rather than failing whole. */
function json(formData: FormData, name: string, fields: Record<string, string>): unknown {
  const raw = String(formData.get(name) ?? "").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    fields[name] = "is not valid JSON";
    return undefined;
  }
}

/**
 * Creates a tool, or saves changes to one.
 *
 * The secret box is write-only: left empty on an edit, the stored secret is
 * kept. There is no way to read one back, by design -- the API never returns
 * it once saved.
 */
export async function saveTool(_previous: ToolFormState, formData: FormData): Promise<ToolFormState> {
  const id = String(formData.get("id") ?? "");
  const fields: Record<string, string> = {};

  const timeout = Number(formData.get("timeoutMs"));
  const body: Record<string, unknown> = {
    name: String(formData.get("name") ?? "").trim(),
    description: String(formData.get("description") ?? ""),
    method: formData.get("method"),
    url: String(formData.get("url") ?? "").trim(),
    parametersSchema: json(formData, "parametersSchema", fields) ?? { type: "object", properties: {} },
    headers: json(formData, "headers", fields) ?? {},
    authType: formData.get("authType"),
    authHeader: String(formData.get("authHeader") ?? "").trim() || null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
    responseTemplate: String(formData.get("responseTemplate") ?? "").trim() || null,
    isSlow: formData.get("isSlow") === "on",
  };
  const secret = String(formData.get("authSecret") ?? "");
  if (secret) body.authSecret = secret;
  if (Object.keys(fields).length > 0) return { error: "Fix the highlighted fields.", fields };

  const result = id
    ? await mutate<{ tool: Tool }>("PATCH", `/tools/${id}`, body)
    : await mutate<{ tool: Tool }>("POST", "/tools", body);
  if (!result.ok) return { error: result.body.error, fields: result.body.fields };

  revalidatePath("/tools");
  redirect("/tools");
}

export async function setToolEnabled(id: string, enabled: boolean): Promise<{ error?: string }> {
  const result = await mutate("PATCH", `/tools/${id}`, { enabled });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/tools");
  return {};
}
