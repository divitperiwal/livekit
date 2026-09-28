"use client";

import { useActionState, useState, useTransition } from "react";

import { buttonClass, ErrorNotice, Field, inputClass, SuccessNotice } from "../form";
import {
  addDocument,
  createKnowledgeBase,
  deleteDocument,
  deleteKnowledgeBase,
  type KnowledgeFormState,
} from "./actions";

export function CreateKnowledgeBase() {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(createKnowledgeBase, {});
  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="name" className={inputClass} placeholder="Showroom FAQ" />
        </Field>
        <Field label="Description" hint="optional">
          <input name="description" className={inputClass} placeholder="Prices, hours, service policy" />
        </Field>
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating…" : "Create knowledge base"}
      </button>
    </form>
  );
}

/**
 * Adding a document. A file is read in the browser into the text box, so
 * what is added is exactly what is shown; plain text and markdown only.
 */
export function AddDocument({ id }: { id: string }) {
  const [state, action, pending] = useActionState<KnowledgeFormState, FormData>(addDocument, {});
  const [mode, setMode] = useState<"text" | "url">("text");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");

  async function pick(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <ErrorNotice message={state.error} />
      <SuccessNotice>{state.added}</SuccessNotice>
      <div className="flex gap-4 text-sm">
        {(["text", "url"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
            {m === "text" ? "Text or file" : "A web page"}
          </label>
        ))}
      </div>
      <fieldset disabled={pending} className="space-y-3">
        <Field label="Title" hint="optional">
          <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
        </Field>
        {mode === "url" ? (
          <Field label="URL" hint="fetched once, now; add it again to refresh">
            <input name="url" className={`${inputClass} font-mono text-xs`} placeholder="https://example.com/faq" />
          </Field>
        ) : (
          <>
            <input type="file" accept=".txt,.md,.csv,text/plain,text/markdown" onChange={(e) => pick(e.target.files?.[0])} className="text-sm" />
            <textarea
              name="text"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className={`${inputClass} text-sm`}
              placeholder={"Service centre hours: Monday to Saturday, 9am to 7pm.\n\nThar starts at ₹11.35 lakh ex-showroom."}
            />
          </>
        )}
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add document"}
      </button>
    </form>
  );
}

export function DeleteDocument({ knowledgeBaseId, documentId }: { knowledgeBaseId: string; documentId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm("Delete this document? Agents stop finding it from their next call.")) return;
        startTransition(async () => {
          await deleteDocument(knowledgeBaseId, documentId);
        });
      }}
      className="text-sm text-neutral-500 hover:underline"
    >
      Delete
    </button>
  );
}

export function DeleteKnowledgeBase({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm("Delete this knowledge base and every document in it?")) return;
        startTransition(async () => {
          await deleteKnowledgeBase(id);
        });
      }}
      className="text-sm text-red-600 hover:underline"
    >
      Delete knowledge base
    </button>
  );
}
