"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { mutate } from "@/lib/mutate";

export interface FormState {
  error?: string;
  message?: string;
}

/** Creates an agent with a starter prompt, published so it can be test-called at once. */
export async function createAgent(_previous: FormState, formData: FormData): Promise<FormState> {
  const result = await mutate<{ agent: { id: string } }>("POST", "/agents", {
    name: String(formData.get("name") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || undefined,
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/agents");
  redirect(`/agents/${result.body.agent.id}`);
}

/** Starts, changes or stops an A/B experiment on an agent. */
export async function setExperiment(_previous: FormState, formData: FormData): Promise<FormState> {
  const agentId = String(formData.get("agentId") ?? "");
  const versionId = String(formData.get("versionId") ?? "");
  const result = await mutate(
    "PUT",
    `/agents/${agentId}/experiment`,
    versionId ? { versionId, percent: Number(formData.get("percent") ?? 10) } : { versionId: null },
  );
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/agents/${agentId}`);
  return { message: versionId ? "Experiment running. It applies from the next call." : "Experiment stopped." };
}
