"use client";

import { useActionState } from "react";

import type { Campaign } from "@/lib/api";

import { buttonClass, ErrorNotice, Field, inputClass, SuccessNotice } from "../form";
import { createCampaign, updateCampaign, type CampaignFormState } from "./actions";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const OUTCOMES = [
  { value: "no_answer", label: "No answer" },
  { value: "busy", label: "Busy or declined" },
  { value: "voicemail", label: "Voicemail" },
  { value: "failed", label: "Failed to connect" },
];

/**
 * A campaign's settings: creating one, or changing one that exists.
 *
 * One calling window per campaign here, although the API takes several. It
 * covers nearly every real schedule, and a form for a list of windows is a
 * lot of form for the rare case that needs it.
 */
export function CampaignForm({
  campaign,
  agents,
  numbers,
  timezones,
  readOnly,
}: {
  campaign?: Campaign;
  agents: Array<{ id: string; name: string }>;
  numbers: Array<{ id: string; e164: string }>;
  timezones: string[];
  readOnly: boolean;
}) {
  const [state, action, pending] = useActionState<CampaignFormState, FormData>(
    campaign ? updateCampaign : createCampaign,
    {},
  );
  const fields = state.fields ?? {};
  const hours = campaign?.schedule.windows[0] ?? { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" };
  const retry = campaign?.retryPolicy ?? {
    maxAttempts: 3,
    retryAfterMinutes: [60, 240],
    retryOn: ["no_answer", "busy", "voicemail", "failed"],
  };
  const scheduleError = Object.entries(fields).find(([key]) => key.startsWith("schedule"))?.[1];
  const retryError = Object.entries(fields).find(([key]) => key.startsWith("retryPolicy"))?.[1];

  return (
    <form action={action} className="space-y-4">
      {campaign ? <input type="hidden" name="id" value={campaign.id} /> : null}
      <ErrorNotice message={state.error} />
      <SuccessNotice>{state.saved ? "Saved. The dialer uses these from its next round." : null}</SuccessNotice>

      <fieldset disabled={readOnly || pending} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={fields.name}>
            <input name="name" defaultValue={campaign?.name} className={inputClass} placeholder="Service reminders — October" />
          </Field>
          <Field label="Agent" error={fields.agentId}>
            <select name="agentId" defaultValue={campaign?.agentId} className={inputClass}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Call from" hint="the caller ID people see" error={fields.fromNumberId}>
            <select name="fromNumberId" defaultValue={campaign?.fromNumberId ?? numbers[0]?.id ?? ""} className={inputClass}>
              <option value="">Choose before starting</option>
              {numbers.map((number) => (
                <option key={number.id} value={number.id}>
                  {number.e164}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Calls at once" error={fields.concurrency}>
            <input name="concurrency" type="number" min={1} max={50} defaultValue={campaign?.concurrency ?? 5} className={inputClass} />
          </Field>
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium">When to call</span>
          <span className="ml-2 text-xs text-neutral-500">
            Indian numbers are never called before 09:00 or after 21:00 India time, whatever this says
          </span>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((day, index) => (
              <label key={day} className="flex items-center gap-1 text-sm">
                <input type="checkbox" name="days" value={index + 1} defaultChecked={hours.days.includes(index + 1)} />
                {day}
              </label>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From">
              <input name="start" type="time" defaultValue={hours.start} className={inputClass} />
            </Field>
            <Field label="Until">
              <input name="end" type="time" defaultValue={hours.end} className={inputClass} />
            </Field>
            <Field label="Timezone">
              <select name="timezone" defaultValue={campaign?.schedule.timezone ?? "Asia/Kolkata"} className={inputClass}>
                {timezones.map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
            </Field>
          </div>
          {scheduleError ? <p className="text-xs text-red-600">{scheduleError}</p> : null}
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium">Trying again</span>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Attempts per contact" hint="including the first">
              <input name="maxAttempts" type="number" min={1} max={10} defaultValue={retry.maxAttempts} className={inputClass} />
            </Field>
            <Field label="Wait between attempts" hint="minutes, comma separated; the last repeats">
              <input name="retryAfterMinutes" defaultValue={retry.retryAfterMinutes.join(", ")} className={inputClass} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            {OUTCOMES.map((outcome) => (
              <label key={outcome.value} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  name="retryOn"
                  value={outcome.value}
                  defaultChecked={retry.retryOn.includes(outcome.value)}
                />
                {outcome.label}
              </label>
            ))}
          </div>
          {retryError ? <p className="text-xs text-red-600">{retryError}</p> : null}
        </div>
      </fieldset>

      {readOnly ? null : (
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : campaign ? "Save settings" : "Create campaign"}
        </button>
      )}
    </form>
  );
}
