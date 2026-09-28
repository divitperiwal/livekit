"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { KnowledgeBase } from "@/lib/api";
import { mutate } from "@/lib/mutate";

export interface KnowledgeFormState {
  error?: string;
  added?: string;
}

export async function createKnowledgeBase(
  _previous: KnowledgeFormState,
  formData: FormData,
): Promise<KnowledgeFormState> {
  const result = await mutate<{ knowledgeBase: KnowledgeBase }>("POST", "/knowledge-bases", {
    name: String(formData.get("name") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || undefined,
  });
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/knowledge");
  redirect(`/knowledge/${result.body.knowledgeBase.id}`);
}

/** Adds a document from pasted or uploaded text, or from a URL fetched now. */
export async function addDocument(_previous: KnowledgeFormState, formData: FormData): Promise<KnowledgeFormState> {
  const id = String(formData.get("id") ?? "");
  const url = String(formData.get("url") ?? "").trim();
  const text = String(formData.get("text") ?? "");
  const title = String(formData.get("title") ?? "").trim() || undefined;
  if (!url && !text.trim()) return { error: "Paste the text, choose a file, or give a URL." };

  const result = await mutate<{ document: { title: string; chunkCount: number } }>(
    "POST",
    `/knowledge-bases/${id}/documents`,
    url ? { title, url } : { title, text },
  );
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/knowledge/${id}`);
  return { added: `Added “${result.body.document.title}” as ${result.body.document.chunkCount} passages.` };
}

export async function deleteDocument(knowledgeBaseId: string, documentId: string): Promise<{ error?: string }> {
  const result = await mutate("DELETE", `/knowledge-bases/${knowledgeBaseId}/documents/${documentId}`);
  if (!result.ok) return { error: result.body.error };
  revalidatePath(`/knowledge/${knowledgeBaseId}`);
  return {};
}

export async function deleteKnowledgeBase(id: string): Promise<{ error?: string }> {
  const result = await mutate("DELETE", `/knowledge-bases/${id}`);
  if (!result.ok) return { error: result.body.error };
  revalidatePath("/knowledge");
  redirect("/knowledge");
}
