"use client";

import { useActionState, useState, useTransition } from "react";

import { buttonClass, ErrorNotice, Field, inputClass, SuccessNotice } from "../../../form";
import { addScenario, deleteScenario, runSuite, type FormState } from "./actions";

export function AddScenario({ agentId }: { agentId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addScenario, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="agentId" value={agentId} />
      <ErrorNotice message={state.error} />
      <SuccessNotice>{state.message}</SuccessNotice>
      <fieldset disabled={pending} className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Name">
            <input name="name" className={inputClass} placeholder="Price question in Hindi" />
          </Field>
          <Field label="Max turns">
            <input name="maxTurns" type="number" min={1} max={20} defaultValue={8} className={inputClass} />
          </Field>
        </div>
        <Field label="The caller" hint="who they are, what they want, how they talk">
          <textarea
            name="caller"
            rows={3}
            className={inputClass}
            placeholder="A farmer from Ambala who wants the on-road price of a Thar. Speaks Hindi, is impatient, and asks for a discount twice."
          />
        </Field>
        <Field label="The agent must" hint="one requirement per line; each is judged pass or fail">
          <textarea
            name="criteria"
            rows={3}
            className={inputClass}
            placeholder={"Give the on-road price\nNot promise a discount\nOffer a test drive"}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Variables" hint="optional; name: value per line">
            <textarea name="variables" rows={2} className={`${inputClass} font-mono text-xs`} placeholder="name: Ramesh" />
          </Field>
          <Field label="Tool answers" hint="optional; tool: what it returns">
            <textarea
              name="toolResponses"
              rows={2}
              className={`${inputClass} font-mono text-xs`}
              placeholder="lookup_price: Thar LX on-road Ambala Rs 14.2 lakh"
            />
          </Field>
        </div>
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add scenario"}
      </button>
    </form>
  );
}

export function DeleteScenario({ agentId, scenarioId }: { agentId: string; scenarioId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await deleteScenario(agentId, scenarioId)))}
      className="text-sm text-neutral-500 hover:underline"
    >
      Delete
    </button>
  );
}

export function RunSuite({
  agentId,
  versions,
  liveVersionId,
}: {
  agentId: string;
  versions: Array<{ id: string; version: number }>;
  liveVersionId: string | null;
}) {
  const [versionId, setVersionId] = useState(liveVersionId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={versionId} onChange={(e) => setVersionId(e.target.value)} className={`${inputClass} mt-0 w-auto`}>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version}
              {v.id === liveVersionId ? " (live)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending}
          className={buttonClass}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await runSuite(agentId, versionId || null);
              if (result.error) setError(result.error);
            })
          }
        >
          {pending ? "Starting…" : "Run all scenarios"}
        </button>
      </div>
      <ErrorNotice message={error ?? undefined} />
    </div>
  );
}
