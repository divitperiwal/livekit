"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Campaign } from "@/lib/api";
import { mutate } from "@/lib/mutate";

export interface CampaignFormState {
  error?: string;
  fields?: Record<string, string>;
  saved?: boolean;
}

/** Reads the campaign form into the shape the API takes. */
function settingsFrom(formData: FormData) {
  const days = formData.getAll("days").map(Number);
  const waits = String(formData.get("retryAfterMinutes") ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    name: String(formData.get("name") ?? "").trim(),
    agentId: String(formData.get("agentId") ?? "") || undefined,
    fromNumberId: String(formData.get("fromNumberId") ?? "") || null,
    concurrency: Number(formData.get("concurrency") ?? 5),
    schedule: {
      timezone: String(formData.get("timezone") ?? "Asia/Kolkata"),
      windows: [
        {
          days,
          start: String(formData.get("start") ?? "10:00"),
          end: String(formData.get("end") ?? "19:00"),
        },
      ],
    },
    retryPolicy: {
      maxAttempts: Number(formData.get("maxAttempts") ?? 3),
      retryAfterMinutes: waits,
      retryOn: formData.getAll("retryOn").map(String),
    },
  };
}

export async function createCampaign(
  _previous: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const result = await mutate<{ campaign: Campaign }>("POST", "/campaigns", settingsFrom(formData));
  if (!result.ok) return { error: result.body.error, fields: result.body.fields };

  revalidatePath("/campaigns");
  redirect(`/campaigns/${result.body.campaign.id}`);
}

export async function updateCampaign(
  _previous: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const id = String(formData.get("id") ?? "");
  const result = await mutate("PATCH", `/campaigns/${id}`, settingsFrom(formData));
  if (!result.ok) return { error: result.body.error, fields: result.body.fields };

  revalidatePath(`/campaigns/${id}`);
  return { saved: true };
}

export async function changeCampaignStatus(
  id: string,
  action: "start" | "pause" | "resume" | "cancel",
): Promise<{ error?: string }> {
  const result = await mutate("POST", `/campaigns/${id}/${action}`, {});
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/campaigns");
  return {};
}

export interface UploadState {
  error?: string;
  result?: {
    added: number;
    duplicates: number;
    suppressed: number;
    rejected: number;
    rejectedRows: Array<{ row: number; value: string; reason: string }>;
  };
}

export async function uploadContacts(_previous: UploadState, formData: FormData): Promise<UploadState> {
  const id = String(formData.get("id") ?? "");
  const csv = String(formData.get("csv") ?? "");
  if (!csv.trim()) return { error: "Paste a list or choose a CSV file first." };

  const result = await mutate<NonNullable<UploadState["result"]>>("POST", `/campaigns/${id}/contacts`, { csv });
  if (!result.ok) return { error: result.body.error };

  revalidatePath(`/campaigns/${id}`);
  return { result: result.body };
}
