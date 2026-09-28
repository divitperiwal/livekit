"use client";

import { useActionState, useState, useTransition } from "react";

import type { Settings } from "@/lib/api";

import { buttonClass, ErrorNotice, Field, inputClass, SuccessNotice } from "../form";
import {
  createKey,
  createWebhook,
  revokeKey,
  saveRecording,
  webhookAction,
  type FormState,
} from "./actions";

/** A secret shown once, with a warning that it will not be shown again. */
function OnceOnly({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p className="font-medium">{label} — copy it now. It will not be shown again.</p>
      <code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-neutral-900">{value}</code>
    </div>
  );
}

export function RecordingForm({ settings, readOnly }: { settings: Settings; readOnly: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveRecording, {});
  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      <SuccessNotice>{state.saved ? "Saved. Calls that start from now on follow it." : null}</SuccessNotice>
      {!settings.recordingStorageConfigured ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          No recording storage is configured on this deployment (RECORDING_S3_*), so nothing will be recorded until it is.
        </p>
      ) : null}
      <fieldset disabled={readOnly || pending} className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="recordCalls" defaultChecked={settings.recordCalls} />
          Record calls. The agent tells each caller the call is recorded.
        </label>
        <Field label="Keep recordings for" hint="days; deleted automatically after">
          <input
            name="recordingRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={settings.recordingRetentionDays}
            className={`${inputClass} max-w-40`}
          />
        </Field>
      </fieldset>
      {readOnly ? null : (
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : "Save"}
        </button>
      )}
    </form>
  );
}

export function CreateKeyForm({ scopes }: { scopes: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createKey, {});
  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      <OnceOnly label="Your new API key" value={state.secret} />
      <fieldset disabled={pending} className="space-y-3">
        <Field label="Name" hint="after what will use it">
          <input name="name" className={`${inputClass} max-w-sm`} placeholder="CRM sync" />
        </Field>
        <div className="flex flex-wrap gap-3">
          {scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-1 text-sm">
              <input type="checkbox" name="scopes" value={scope} defaultChecked />
              <code className="text-xs">{scope}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating…" : "Create key"}
      </button>
    </form>
  );
}

export function RevokeKey({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Revoke this key? Anything using it stops working immediately.")) return;
          startTransition(async () => {
            const result = await revokeKey(id);
            if (result.error) setError(result.error);
          });
        }}
        className="text-sm text-neutral-500 hover:underline"
      >
        Revoke
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

export function CreateWebhookForm({ events }: { events: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createWebhook, {});
  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      <OnceOnly label="The endpoint's signing secret" value={state.secret} />
      <fieldset disabled={pending} className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="URL" hint="https, reachable from the internet">
            <input name="url" className={`${inputClass} font-mono text-xs`} placeholder="https://crm.example.com/hooks/automitra" />
          </Field>
          <Field label="Description" hint="optional">
            <input name="description" className={inputClass} placeholder="LeadSquared sync" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-3">
          {events.map((event) => (
            <label key={event} className="flex items-center gap-1 text-sm">
              <input type="checkbox" name="events" value={event} defaultChecked />
              <code className="text-xs">{event}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add endpoint"}
      </button>
    </form>
  );
}

export function WebhookControls({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  function run(action: "enable" | "disable" | "delete" | "test") {
    if (action === "delete" && !window.confirm("Delete this endpoint? Pending deliveries to it are dropped.")) return;
    setNote(null);
    startTransition(async () => {
      const result = await webhookAction(id, action);
      setNote(result.error ?? result.message ?? null);
    });
  }

  const link = "text-sm text-neutral-500 hover:underline disabled:opacity-60";
  return (
    <span className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={pending} onClick={() => run("test")} className={link}>
        Send test
      </button>
      <button type="button" disabled={pending} onClick={() => run(enabled ? "disable" : "enable")} className={link}>
        {enabled ? "Disable" : "Enable"}
      </button>
      <button type="button" disabled={pending} onClick={() => run("delete")} className={link}>
        Delete
      </button>
      {note ? <span className="text-xs text-neutral-500">{note}</span> : null}
    </span>
  );
}
