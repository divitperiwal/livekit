"use client";

import { useActionState, useState } from "react";

import type { AgentVersion, KnowledgeBase, Tool } from "@/lib/api";

import { Field, inputClass } from "../../form";
import { publish, type PublishState } from "./actions";

interface TransferRow {
  name: string;
  number: string;
  description: string;
}

/** Hours are kept as typed; the action turns them into numbers. */
interface ClosingRow {
  start: string;
  end: string;
  text: string;
}

interface FieldRow {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  description: string;
  /** Comma-separated in the form; a list in the configuration. */
  options: string;
}

const DEFAULT_DISPOSITIONS =
  "interested, not_interested, callback_requested, resolved, unresolved, wrong_number, do_not_call";

interface Choices {
  sttModels: string[];
  sttModes: string[];
  llmModels: string[];
  ttsModels: string[];
  ttsLanguages: string[];
  speakersByModel: Record<string, string[]>;
  timezones: string[];
  fallbackLlms: string[];
  fallbackStts: string[];
  fallbackTtss: string[];
}

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
  tools,
  toolIds,
  knowledgeBases,
  knowledgeBaseIds,
  readOnly,
}: {
  agentId: string;
  live: AgentVersion | null;
  choices: Choices;
  tools: Tool[];
  toolIds: string[];
  knowledgeBases: KnowledgeBase[];
  knowledgeBaseIds: string[];
  readOnly: boolean;
}) {
  const config = (live?.config ?? {}) as Record<string, unknown>;
  const [state, action, pending] = useActionState<PublishState, FormData>(publish, {});

  // Kept as state and sent as one JSON field: a variable-length list of rows
  // does not map onto flat form fields without inventing a naming scheme.
  const [transfers, setTransfers] = useState<TransferRow[]>(
    ((config.transferTargets as TransferRow[] | undefined) ?? []).map((t) => ({
      name: t.name,
      number: t.number,
      description: t.description ?? "",
    })),
  );
  const [closingLines, setClosingLines] = useState<ClosingRow[]>(
    ((config.closingLines as Array<{ start: number; end: number; text: string }> | undefined) ?? []).map(
      (line) => ({ start: String(line.start), end: String(line.end), text: line.text }),
    ),
  );

  function updateClosing(index: number, patch: Partial<ClosingRow>) {
    setClosingLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  const [voicemailAction, setVoicemailAction] = useState(String(config.voicemailAction ?? "hangup"));

  function updateTransfer(index: number, patch: Partial<TransferRow>) {
    setTransfers((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  const [analysisFields, setAnalysisFields] = useState<FieldRow[]>(
    (
      (config.analysisFields as Array<{ name: string; type?: FieldRow["type"]; description?: string; options?: string[] }>) ?? []
    ).map((f) => ({
      name: f.name,
      type: f.type ?? "string",
      description: f.description ?? "",
      options: (f.options ?? []).join(", "),
    })),
  );

  function updateField(index: number, patch: Partial<FieldRow>) {
    setAnalysisFields((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

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

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="greetingVerbatim"
              defaultChecked={config.greetingMode === "verbatim"}
              className="mt-0.5"
            />
            <span>
              Say the opening line word for word
              <span className="block text-xs text-neutral-500">
                No model request, and its audio is reused across calls — the cheapest
                way to open. Off: the opening line is an instruction the model follows.
              </span>
            </span>
          </label>

          <Field
            label="Recording notice"
            hint="said after a word-for-word opening line on recorded calls; empty uses a default for Hindi and English"
            error={fields.recordingNotice}
          >
            <input
              name="recordingNotice"
              defaultValue={String(config.recordingNotice ?? "")}
              className={inputClass}
              placeholder="यह call record की जा रही है।"
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

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="sttRealtime"
              defaultChecked={config.sttRealtime !== false}
              className="mt-0.5"
            />
            <span>
              Realtime speech to text
              <span className="block text-xs text-neutral-500">
                Sarvam&apos;s realtime endpoint, finalising each utterance as soon as the caller
                stops — about a quarter of a second sooner per reply. Off: the streaming endpoint.
              </span>
            </span>
          </label>

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

          <Field
            label="Cost ceiling per minute"
            hint="rupees, at most 2; speech over it is never spoken, so never billed"
            error={fields.maxInrPerMin}
          >
            <input
              name="maxInrPerMin"
              type="number"
              step="0.05"
              min="0.6"
              max="2"
              defaultValue={String(config.maxInrPerMin || 2.5)}
              className={inputClass}
            />
          </Field>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium">Tools</h2>
          {tools.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No tools yet. Add them on the{" "}
              <a href="/tools" className="underline">
                Tools
              </a>{" "}
              page.
            </p>
          ) : (
            <div className="space-y-2">
              {tools.map((tool) => (
                <label key={tool.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="toolIds"
                    value={tool.id}
                    defaultChecked={toolIds.includes(tool.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-mono">{tool.name}</span>
                    {tool.enabled ? null : <span className="ml-2 text-xs text-amber-600">disabled</span>}
                    <span className="block text-xs text-neutral-500">{tool.description}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {knowledgeBases.length > 0 ? (
            <div className="space-y-2 pt-2">
              <span className="text-sm font-medium">Knowledge it can search</span>
              {knowledgeBases.map((kb) => (
                <label key={kb.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="knowledgeBaseIds"
                    value={kb.id}
                    defaultChecked={knowledgeBaseIds.includes(kb.id)}
                    className="mt-1"
                  />
                  <span>
                    {kb.name}
                    {kb.description ? <span className="block text-xs text-neutral-500">{kb.description}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-neutral-500">
            Write <code>{"{{name}}"}</code> in the prompt or opening line to use a value from the call, such
            as a campaign contact&apos;s columns. <code>{"{{name|there}}"}</code> gives a fallback.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">Call control</h2>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="endCallEnabled" defaultChecked={config.endCallEnabled !== false} />
            The agent may hang up once the conversation is over
          </label>

          <div className="space-y-2">
            <span className="text-sm font-medium">Closing lines</span>
            <span className="ml-2 text-xs text-neutral-500">
              said as the call ends, chosen by the hour in the agent&apos;s timezone; from is
              inclusive, to is exclusive, and a from after to runs through midnight.{" "}
              <code>{"{{caller_name}}"}</code> is the name the caller gave. Leave empty to let
              the model say goodbye, and keep closing lines out of the prompt when set.
            </span>
            {fields.closingLines ? (
              <span className="block text-xs text-red-600">{fields.closingLines}</span>
            ) : null}
            <input type="hidden" name="closingLines" value={JSON.stringify(closingLines)} />
            {closingLines.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[5rem_5rem_1fr_auto]">
                <input
                  value={row.start}
                  onChange={(e) => updateClosing(index, { start: e.target.value })}
                  inputMode="numeric"
                  placeholder="9"
                  aria-label="From hour"
                  className={inputClass}
                />
                <input
                  value={row.end}
                  onChange={(e) => updateClosing(index, { end: e.target.value })}
                  inputMode="numeric"
                  placeholder="18"
                  aria-label="To hour"
                  className={inputClass}
                />
                <input
                  value={row.text}
                  onChange={(e) => updateClosing(index, { text: e.target.value })}
                  placeholder="ठीक है {{caller_name}} जी, हमारी टीम से आपको दस से पंद्रह मिनट में call आ जाएगा।"
                  aria-label="Line"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setClosingLines((rows) => rows.filter((_, i) => i !== index))}
                  className="mt-1 text-sm text-neutral-500 hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setClosingLines((rows) => [...rows, { start: "", end: "", text: "" }])}
              className="block text-sm underline-offset-4 hover:underline"
            >
              + Add a closing line
            </button>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">Transfer to a person</span>
            <span className="ml-2 text-xs text-neutral-500">
              phone calls only; the carrier trunk must allow transfers
            </span>
            {fields.transferTargets ? (
              <span className="block text-xs text-red-600">{fields.transferTargets}</span>
            ) : null}
            <input type="hidden" name="transferTargets" value={JSON.stringify(transfers)} />
            {transfers.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[10rem_11rem_1fr_auto]">
                <input
                  value={row.name}
                  onChange={(e) => updateTransfer(index, { name: e.target.value })}
                  placeholder="sales"
                  aria-label="Name"
                  className={inputClass}
                />
                <input
                  value={row.number}
                  onChange={(e) => updateTransfer(index, { number: e.target.value })}
                  placeholder="+911234567890"
                  aria-label="Number"
                  className={`${inputClass} font-mono`}
                />
                <input
                  value={row.description}
                  onChange={(e) => updateTransfer(index, { description: e.target.value })}
                  placeholder="When to transfer here"
                  aria-label="When to use"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setTransfers((rows) => rows.filter((_, i) => i !== index))}
                  className="mt-1 text-sm text-neutral-500 hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setTransfers((rows) => [...rows, { name: "", number: "", description: "" }])}
              className="block text-sm underline-offset-4 hover:underline"
            >
              + Add a transfer number
            </button>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="voicemailDetection"
                defaultChecked={config.voicemailDetection !== false}
              />
              Detect answering machines on outbound calls
            </label>
            <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
              <Field label="On a machine" error={fields.voicemailAction}>
                <select
                  name="voicemailAction"
                  value={voicemailAction}
                  onChange={(e) => setVoicemailAction(e.target.value)}
                  className={inputClass}
                >
                  <option value="hangup">Hang up</option>
                  <option value="leave_message">Leave a message</option>
                </select>
              </Field>
              {voicemailAction === "leave_message" ? (
                <Field
                  label="Message"
                  hint="empty: the agent writes one from its prompt"
                  error={fields.voicemailMessage}
                >
                  <textarea
                    name="voicemailMessage"
                    rows={2}
                    defaultValue={String(config.voicemailMessage ?? "")}
                    className={inputClass}
                    placeholder="Namaste {{name}}, this is Simran from KBS Motors about your service booking. Please call us back on..."
                  />
                </Field>
              ) : null}
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">Silence and the keypad</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Check on a silent caller after" hint="seconds" error={fields.silenceTimeout}>
              <input
                name="silenceTimeout"
                type="number"
                min={5}
                max={120}
                defaultValue={String(config.silenceTimeout ?? 15)}
                className={inputClass}
              />
            </Field>
            <Field label="Checks before hanging up" hint="0 never hangs up on silence" error={fields.silenceChecks}>
              <input
                name="silenceChecks"
                type="number"
                min={0}
                max={5}
                defaultValue={String(config.silenceChecks ?? 2)}
                className={inputClass}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="dtmfInput" defaultChecked={config.dtmfInput !== false} />
            Pass keys the caller presses to the agent
          </label>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">If Sarvam fails</h2>
          <p className="text-xs text-neutral-500">
            Switch to a LiveKit Inference model mid-call instead of going silent. LiveKit Cloud only, billed there; a
            voice failover changes the voice.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["fallbackStt", "Speech to text", choices.fallbackStts],
                ["fallbackLlm", "Language model", choices.fallbackLlms],
                ["fallbackTts", "Voice", choices.fallbackTtss],
              ] as const
            ).map(([name, label, list]) => (
              <Field key={name} label={label} error={fields[name]}>
                <select name={name} defaultValue={String(config[name] ?? "")} className={inputClass}>
                  <option value="">No fallback</option>
                  {list.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <Field label="Fallback voice" hint="the provider's voice id, if the model needs one" error={fields.fallbackTtsVoice}>
            <input name="fallbackTtsVoice" defaultValue={String(config.fallbackTtsVoice ?? "")} className={inputClass} />
          </Field>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">After the call</h2>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="analysisEnabled" defaultChecked={config.analysisEnabled !== false} />
            Write a summary, a disposition and the fields below once each call ends
          </label>

          <Field
            label="Dispositions"
            hint="comma separated; the one label each call ends with"
            error={fields.dispositions}
          >
            <input
              name="dispositions"
              defaultValue={((config.dispositions as string[] | undefined) ?? []).join(", ") || DEFAULT_DISPOSITIONS}
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>

          <Field
            label="Quality checks"
            hint="one per line; each call is scored pass or fail on each"
            error={fields.qaCriteria}
          >
            <textarea
              name="qaCriteria"
              rows={3}
              defaultValue={((config.qaCriteria as string[] | undefined) ?? []).join("\n")}
              className={inputClass}
              placeholder={"Confirmed the appointment date and time\nDid not quote a price without checking"}
            />
          </Field>

          <div className="space-y-2">
            <span className="text-sm font-medium">Fields to fill in</span>
            <span className="ml-2 text-xs text-neutral-500">sent in webhooks and the API, keyed by name</span>
            {fields.analysisFields ? (
              <span className="block text-xs text-red-600">{fields.analysisFields}</span>
            ) : null}
            <input type="hidden" name="analysisFields" value={JSON.stringify(analysisFields)} />
            {analysisFields.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[10rem_7rem_1fr_auto]">
                <input
                  value={row.name}
                  onChange={(e) => updateField(index, { name: e.target.value })}
                  placeholder="callback_time"
                  aria-label="Name"
                  className={`${inputClass} font-mono text-xs`}
                />
                <select
                  value={row.type}
                  onChange={(e) => updateField(index, { type: e.target.value as FieldRow["type"] })}
                  aria-label="Type"
                  className={inputClass}
                >
                  <option value="string">text</option>
                  <option value="number">number</option>
                  <option value="boolean">yes / no</option>
                  <option value="enum">one of…</option>
                </select>
                <input
                  value={row.type === "enum" ? row.options : row.description}
                  onChange={(e) =>
                    updateField(index, row.type === "enum" ? { options: e.target.value } : { description: e.target.value })
                  }
                  placeholder={row.type === "enum" ? "Thar, XUV700, Scorpio-N" : "When the caller wants to be called back"}
                  aria-label={row.type === "enum" ? "Options" : "What to look for"}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setAnalysisFields((rows) => rows.filter((_, i) => i !== index))}
                  className="mt-1 text-sm text-neutral-500 hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setAnalysisFields((rows) => [...rows, { name: "", type: "string", description: "", options: "" }])
              }
              className="block text-sm underline-offset-4 hover:underline"
            >
              + Add a field
            </button>
          </div>
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
