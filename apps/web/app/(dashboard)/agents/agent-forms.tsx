"use client";

import { useActionState } from "react";

import { buttonClass, ErrorNotice, Field, inputClass, SuccessNotice } from "../form";
import { createAgent, setExperiment, type FormState } from "./agent-actions";

export function CreateAgentForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createAgent, {});
  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="name" className={inputClass} placeholder="Service desk" />
        </Field>
        <Field label="Description" hint="optional">
          <input name="description" className={inputClass} placeholder="Answers the service line" />
        </Field>
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating…" : "Create agent"}
      </button>
    </form>
  );
}

/**
 * Sends a share of calls to another version. Both keep their own call
 * records, so Analytics compares them side by side.
 */
export function ExperimentForm({
  agentId,
  liveVersionId,
  candidateVersionId,
  candidatePercent,
  versions,
  readOnly,
}: {
  agentId: string;
  liveVersionId: string | null;
  candidateVersionId: string | null;
  candidatePercent: number;
  versions: Array<{ id: string; version: number }>;
  readOnly: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(setExperiment, {});
  const others = versions.filter((v) => v.id !== liveVersionId);
  if (others.length === 0) {
    return <p className="text-sm text-neutral-500">Publish a second version to compare it against the live one.</p>;
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="agentId" value={agentId} />
      <ErrorNotice message={state.error} />
      <SuccessNotice>{state.message}</SuccessNotice>
      <fieldset disabled={readOnly || pending} className="flex flex-wrap items-end gap-3">
        <Field label="Send">
          <input
            name="percent"
            type="number"
            min={1}
            max={99}
            defaultValue={candidatePercent || 10}
            className={`${inputClass} w-20`}
          />
        </Field>
        <span className="pb-2 text-sm">% of calls to</span>
        <Field label="Version">
          <select name="versionId" defaultValue={candidateVersionId ?? ""} className={inputClass}>
            <option value="">No experiment</option>
            {others.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}
              </option>
            ))}
          </select>
        </Field>
        {readOnly ? null : (
          <button type="submit" disabled={pending} className={buttonClass}>
            {pending ? "Saving…" : "Apply"}
          </button>
        )}
      </fieldset>
    </form>
  );
}
