"use client";

import { useActionState, useState, useTransition } from "react";

import { buttonClass, ErrorNotice, Field, inputClass, SuccessNotice } from "../form";
import { suppress, unsuppress, type SuppressState } from "./actions";

export function AddNumbers() {
  const [state, action, pending] = useActionState<SuppressState, FormData>(suppress, {});

  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      <SuccessNotice>
        {state.added !== undefined
          ? `Added ${state.added}.` + (state.invalid?.length ? ` Not phone numbers: ${state.invalid.join(", ")}.` : "")
          : null}
      </SuccessNotice>
      <fieldset disabled={pending} className="space-y-3">
        <Field label="Numbers" hint="one per line, or comma separated">
          <textarea name="numbers" rows={4} className={`${inputClass} font-mono text-xs`} placeholder={"9876543210\n+919876543211"} />
        </Field>
        <Field label="Reason" hint="optional, for whoever reads this later">
          <input name="reason" className={inputClass} placeholder="Asked by email on 3 October" />
        </Field>
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add to the list"}
      </button>
    </form>
  );
}

export function RemoveNumber({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    if (!window.confirm("Take this number off the list? Campaigns will be able to call it again.")) return;
    startTransition(async () => {
      const result = await unsuppress(id);
      if (result.error) setError(result.error);
    });
  }

  return (
    <span className="flex items-center gap-2">
      <button type="button" disabled={pending} onClick={remove} className="text-sm text-neutral-500 hover:underline">
        Remove
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
