"use server";

import { revalidatePath } from "next/cache";

import { mutate } from "@/lib/mutate";

export interface FormState {
  error?: string;
  message?: string;
}

/** Parses "key: value" lines into an object, for variables and tool answers. */
function pairs(raw: FormDataEntryValue | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export async function addScenario(_previous: FormState, formData: FormData): Promise<FormState> {
  const agentId = String(formData.get("agentId") ?? "");
  const result = await mutate("POST", `/agents/${agentId}/scenarios`, {
    name: String(formData.get("name") ?? ""),
    caller: String(formData.get("caller") ?? ""),
    criteria: String(formData.get("criteria") ?? "").split(/\r?\n/).map((c) => c.trim()).filter(Boolean),
    maxTurns: Number(formData.get("maxTurns") ?? 8),
    variables: pairs(formData.get("variables")),
    toolResponses: pairs(formData.get("toolResponses")),
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/agents/${agentId}/tests`);
  return { message: "Scenario added." };
}

export async function deleteScenario(agentId: string, scenarioId: string): Promise<{ error?: string }> {
  const result = await mutate("DELETE", `/scenarios/${scenarioId}`);
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/agents/${agentId}/tests`);
  return {};
}

export async function runSuite(agentId: string, versionId: string | null): Promise<{ error?: string }> {
  const result = await mutate("POST", `/agents/${agentId}/eval-runs`, versionId ? { versionId } : {});
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/agents/${agentId}/tests`);
  return {};
}
