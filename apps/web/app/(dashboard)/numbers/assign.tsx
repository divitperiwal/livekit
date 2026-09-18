"use client";

import { useState, useTransition } from "react";

import { assignAgent } from "./actions";

/**
 * Points a number at an agent.
 *
 * Saves on change rather than behind a button: it is a single choice from a
 * short list, and a form with one dropdown and a Save next to it is more
 * ceremony than the decision deserves.
 */
export function AssignAgent({
  numberId,
  agentId,
  agents,
  readOnly,
}: {
  numberId: string;
  agentId: string | null;
  agents: Array<{ id: string; name: string }>;
  readOnly: boolean;
}) {
  const [selected, setSelected] = useState(agentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: string) {
    const previous = selected;
    setSelected(next);
    setError(null);

    startTransition(async () => {
      const result = await assignAgent(numberId, next || null);
      if (result.error) {
        // Put it back: showing a selection that was not saved is worse than
        // showing the old one with an error beside it.
        setSelected(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={selected}
        disabled={readOnly || pending}
        onChange={(event) => change(event.target.value)}
        className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="">Nobody — calls are refused</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      {pending ? <span className="text-xs text-neutral-400">saving…</span> : null}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
