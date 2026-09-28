"use client";

import { useActionState } from "react";

import { buttonClass, ErrorNotice, Field, inputClass } from "../../(dashboard)/form";
import { accept, type AcceptState } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(accept, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <ErrorNotice message={state.error} />
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Your name" hint="optional">
          <input name="name" autoComplete="name" className={inputClass} />
        </Field>
        <Field label="Password" hint="at least 10 characters">
          <input name="password" type="password" autoComplete="new-password" required className={inputClass} />
        </Field>
      </fieldset>
      <button type="submit" disabled={pending} className={`${buttonClass} w-full`}>
        {pending ? "Joining…" : "Join"}
      </button>
    </form>
  );
}
