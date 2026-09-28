"use server";

import { revalidatePath } from "next/cache";

import { mutate } from "@/lib/mutate";

export interface SuppressState {
  error?: string;
  added?: number;
  invalid?: string[];
}

export async function suppress(_previous: SuppressState, formData: FormData): Promise<SuppressState> {
  const numbers = String(formData.get("numbers") ?? "")
    .split(/[\n,]/)
    .map((n) => n.trim())
    .filter(Boolean);
  if (numbers.length === 0) return { error: "Enter at least one number." };

  const reason = String(formData.get("reason") ?? "").trim();
  const result = await mutate<{ added: number; invalid: string[] }>("POST", "/suppressions", {
    numbers,
    reason: reason || undefined,
  });
  if (!result.ok) return { error: result.body.error };

  revalidatePath("/do-not-call");
  return { added: result.body.added, invalid: result.body.invalid };
}

export async function unsuppress(id: string): Promise<{ error?: string }> {
  const result = await mutate("DELETE", `/suppressions/${id}`);
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/do-not-call");
  return {};
}
