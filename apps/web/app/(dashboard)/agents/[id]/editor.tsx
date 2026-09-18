"use client";

import { useActionState, useState } from "react";

import type { AgentVersion } from "@/lib/api";

import { publish, type PublishState } from "./actions";

interface Choices {
  sttModels: string[];
  sttModes: string[];
  llmModels: string[];
  ttsModels: string[];
  ttsLanguages: string[];
  speakersByModel: Record<string, string[]>;
  timezones: string[];
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint ? <span className="ml-2 text-xs text-neutral-500">{hint}</span> : null}
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-400";

function Select({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value?: string;
  onChange?: (value: string) => void;
  options: string[];
}) {
  return (
    <select
      name={name}
      defaultValue={onChange ? undefined : value}
      value={onChange ? value : undefined}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      className={inputClass}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export function AgentEditor({
  agentId,
  live,
  choices,
  readOnly,
}: {
  agentId: string;
  live: AgentVersion | null;
  choices: Choices;
  readOnly: boolean;
}) {
  const config = (live?.config ?? {}) as Record<string, string | number>;
  const [state, action, pending] = useActionState<PublishState, FormData>(publish, {});

  // The voice roster depends on the model, so the two have to move together:
  // leaving a v2 name selected after switching to v3 would offer a value the
  // API rejects.
  const [ttsModel, setTtsModel] = useState(String(config.ttsModel ?? "bulbul:v3"));
  const speakers = choices.speakersByModel[ttsModel] ?? [];
  const [speaker, setSpeaker] = useState(String(config.ttsSpeaker ?? speakers[0] ?? ""));

  function changeModel(next: string) {
    setTtsModel(next);
    const roster = choices.speakersByModel[next] ?? [];
    if (!roster.includes(speaker)) setSpeaker(roster[0] ?? "");
  }

  const fields = state.fields ?? {};

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="agentId" value={agentId} />

      {state.published ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Published v{state.published}. Calls already running keep the version
          they started on.
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <fieldset disabled={readOnly || pending} className="space-y-6">
        <section className="space-y-4">
          <h2 className="text-sm font-medium">What it says</h2>

          <Field
            label="Opening line"
            hint="the first thing the caller hears"
            error={fields.greeting}
          >
            <textarea
              name="greeting"
              rows={2}
              defaultValue={live?.greeting ?? ""}
              className={inputClass}
            />
          </Field>

          <Field label="Prompt" error={fields.instructions}>
            <textarea
              name="instructions"
              rows={16}
              defaultValue={live?.instructions ?? ""}
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>

          <Field
            label="Prompt mode"
            hint="whether the shared voice rules are prepended"
          >
            <select
              name="promptMode"
              defaultValue={live?.promptMode ?? "prepend_base_rules"}
              className={inputClass}
            >
              <option value="prepend_base_rules">
                Add the shared voice rules (recommended)
              </option>
              <option value="verbatim">
                Use my prompt verbatim — it sets its own rules
              </option>
            </select>
          </Field>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">Voice</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" error={fields.ttsModel}>
              <Select
                name="ttsModel"
                value={ttsModel}
                onChange={changeModel}
                options={choices.ttsModels}
              />
            </Field>

            <Field label="Speaker" error={fields.ttsSpeaker}>
              <Select
                name="ttsSpeaker"
                value={speaker}
                onChange={setSpeaker}
                options={speakers}
              />
            </Field>

            <Field label="Language" error={fields.ttsLanguage}>
              <Select
                name="ttsLanguage"
                value={String(config.ttsLanguage ?? "hi-IN")}
                options={choices.ttsLanguages}
              />
            </Field>

            <Field label="Pace" hint="1.0 is normal" error={fields.ttsPace}>
              <input
                name="ttsPace"
                type="number"
                step="0.05"
                min="0.5"
                max="2"
                defaultValue={String(config.ttsPace ?? 1)}
                className={inputClass}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">Models</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Speech to text" error={fields.sttModel}>
              <Select
                name="sttModel"
                value={String(config.sttModel ?? "saaras:v4")}
                options={choices.sttModels}
              />
            </Field>

            <Field
              label="Transcription mode"
              hint="codemix keeps Hindi and English as spoken"
              error={fields.sttMode}
            >
              <Select
                name="sttMode"
                value={String(config.sttMode ?? "codemix")}
                options={choices.sttModes}
              />
            </Field>

            <Field label="Language model" error={fields.llmModel}>
              <Select
                name="llmModel"
                value={String(config.llmModel ?? "sarvam-105b-conversations")}
                options={choices.llmModels}
              />
            </Field>

            <Field
              label="Timezone"
              hint="for prompts that branch on the hour"
              error={fields.timezone}
            >
              <Select
                name="timezone"
                value={String(config.timezone ?? "Asia/Kolkata")}
                options={choices.timezones}
              />
            </Field>
          </div>

          <Field
            label="Cost ceiling per call"
            hint="rupees; 0 for no limit"
            error={fields.budgetInr}
          >
            <input
              name="budgetInr"
              type="number"
              step="1"
              min="0"
              defaultValue={String(config.budgetInr ?? 0)}
              className={inputClass}
            />
          </Field>
        </section>
      </fieldset>

      {readOnly ? (
        <p className="text-sm text-neutral-500">
          Your role is read-only, so publishing is disabled.
        </p>
      ) : (
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Publishing…" : "Publish new version"}
        </button>
      )}
    </form>
  );
}
