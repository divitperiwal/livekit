"use server";

import { revalidatePath } from "next/cache";

import { mutate } from "@/lib/mutate";

export interface FormState {
  error?: string;
  saved?: boolean;
  /** A key or signing secret, shown once and then never again. */
  secret?: string;
}

export async function saveRecording(_previous: FormState, formData: FormData): Promise<FormState> {
  const result = await mutate("PATCH", "/settings", {
    recordCalls: formData.get("recordCalls") === "on",
    recordingRetentionDays: Number(formData.get("recordingRetentionDays") ?? 30),
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return { saved: true };
}

export async function createKey(_previous: FormState, formData: FormData): Promise<FormState> {
  const scopes = formData.getAll("scopes").map(String);
  const result = await mutate<{ key: string }>("POST", "/api-keys", {
    name: String(formData.get("name") ?? "").trim(),
    scopes: scopes.length ? scopes : undefined,
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return { secret: result.body.key };
}

export async function revokeKey(id: string): Promise<{ error?: string }> {
  const result = await mutate("DELETE", `/api-keys/${id}`);
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return {};
}

export async function createWebhook(_previous: FormState, formData: FormData): Promise<FormState> {
  const events = formData.getAll("events").map(String);
  const result = await mutate<{ secret: string }>("POST", "/webhooks", {
    url: String(formData.get("url") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || undefined,
    events: events.length ? events : undefined,
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return { secret: result.body.secret };
}

export async function webhookAction(
  id: string,
  action: "enable" | "disable" | "delete" | "test",
): Promise<{ error?: string; message?: string }> {
  const result =
    action === "delete"
      ? await mutate("DELETE", `/webhooks/${id}`)
      : action === "test"
        ? await mutate("POST", `/webhooks/${id}/test`, {})
        : await mutate("PATCH", `/webhooks/${id}`, { enabled: action === "enable" });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return action === "test" ? { message: "Test event queued; it is sent within a few seconds." } : {};
}

export async function saveRedaction(enabled: boolean): Promise<{ error?: string }> {
  const result = await mutate("PATCH", "/settings", { redactPii: enabled });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return {};
}

export interface EraseState {
  error?: string;
  report?: { phone: string; calls: number; recordingsDeleted: number; recordingsFailed: string[]; campaignContacts: number };
}

export async function erase(_previous: EraseState, formData: FormData): Promise<EraseState> {
  const result = await mutate<NonNullable<EraseState["report"]>>("POST", "/privacy/erase", {
    phone: String(formData.get("phone") ?? ""),
  });
  if (!result.ok) return { error: result.body.error };
  return { report: result.body };
}

export async function invite(_previous: FormState, formData: FormData): Promise<FormState> {
  const result = await mutate<{ token: string }>("POST", "/team/invites", {
    email: String(formData.get("email") ?? "").trim(),
    role: String(formData.get("role") ?? "viewer"),
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return { secret: result.body.token };
}

export async function memberAction(
  userId: string,
  action: { role: string } | "remove",
): Promise<{ error?: string }> {
  const result =
    action === "remove"
      ? await mutate("DELETE", `/team/members/${userId}`)
      : await mutate("PATCH", `/team/members/${userId}`, action);
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return {};
}

export async function revokeInvite(id: string): Promise<{ error?: string }> {
  const result = await mutate("DELETE", `/team/invites/${id}`);
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/settings");
  return {};
}
