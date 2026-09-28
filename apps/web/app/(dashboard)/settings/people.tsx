"use client";

import { useActionState, useState, useTransition } from "react";

import type { Invite, TeamMember } from "@/lib/api";

import { buttonClass, ErrorNotice, Field, inputClass } from "../form";
import {
  erase,
  invite,
  memberAction,
  revokeInvite,
  saveRedaction,
  type EraseState,
  type FormState,
} from "./actions";

const ROLES = ["viewer", "developer", "admin", "owner"] as const;

export function RedactionToggle({ enabled, readOnly }: { enabled: boolean; readOnly: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={on}
        disabled={readOnly || pending}
        onChange={() => {
          const next = !on;
          setOn(next);
          startTransition(async () => {
            const result = await saveRedaction(next);
            if (result.error) {
              setOn(!next);
              setError(result.error);
            }
          });
        }}
      />
      Mask phone numbers, emails, card numbers, Aadhaar and PAN in stored transcripts and summaries
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

export function EraseForm() {
  const [state, action, pending] = useActionState<EraseState, FormData>(erase, {});
  const r = state.report;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm("Erase this person's data? Transcripts, recordings and campaign details are deleted for good.")) {
          e.preventDefault();
        }
      }}
      className="space-y-3"
    >
      <ErrorNotice message={state.error} />
      {r ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Erased {r.phone}: {r.calls} calls anonymised, {r.recordingsDeleted} recordings deleted, {r.campaignContacts} campaign
          contacts cleared.
          {r.recordingsFailed.length ? ` ${r.recordingsFailed.length} recordings could not be deleted; run it again.` : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Phone number">
          <input name="phone" className={`${inputClass} w-56 font-mono`} placeholder="+919876543210" />
        </Field>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Erasing…" : "Erase"}
        </button>
      </div>
    </form>
  );
}

export function InviteForm({ canInviteOwner }: { canInviteOwner: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(invite, {});
  const link = state.secret && typeof window !== "undefined" ? `${window.location.origin}/invite/${state.secret}` : null;
  return (
    <form action={action} className="space-y-3">
      <ErrorNotice message={state.error} />
      {link ? (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium">Send them this link. It works once, for a week, and will not be shown again.</p>
          <code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-neutral-900">{link}</code>
        </div>
      ) : null}
      <fieldset disabled={pending} className="flex flex-wrap items-end gap-3">
        <Field label="Email">
          <input name="email" type="email" className={`${inputClass} w-64`} placeholder="colleague@example.com" />
        </Field>
        <Field label="Role">
          <select name="role" defaultValue="viewer" className={inputClass}>
            {ROLES.filter((r) => r !== "owner" || canInviteOwner).map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Creating…" : "Create invite link"}
        </button>
      </fieldset>
    </form>
  );
}

export function MemberRow({ member, isSelf, canEdit }: { member: TeamMember; isSelf: boolean; canEdit: boolean }) {
  const [role, setRole] = useState(member.role);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: { role: string } | "remove") {
    if (action === "remove" && !window.confirm(`Remove ${member.email}? They lose access immediately.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await memberAction(member.userId, action);
      if (result.error) {
        setError(result.error);
        setRole(member.role);
      }
    });
  }

  return (
    <li className="flex flex-wrap items-center gap-3 text-sm">
      <span className="min-w-48">
        {member.name ? `${member.name} · ` : ""}
        {member.email}
        {isSelf ? <span className="ml-1 text-xs text-neutral-500">(you)</span> : null}
      </span>
      <select
        value={role}
        disabled={!canEdit || pending}
        onChange={(e) => {
          setRole(e.target.value as TeamMember["role"]);
          run({ role: e.target.value });
        }}
        className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
      >
        {ROLES.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
      {canEdit && !isSelf ? (
        <button type="button" disabled={pending} onClick={() => run("remove")} className="text-neutral-500 hover:underline">
          Remove
        </button>
      ) : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </li>
  );
}

export function RevokeInvite({ invite: pending }: { invite: Invite }) {
  const [busy, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => startTransition(async () => void (await revokeInvite(pending.id)))}
      className="text-sm text-neutral-500 hover:underline"
    >
      Revoke
    </button>
  );
}
