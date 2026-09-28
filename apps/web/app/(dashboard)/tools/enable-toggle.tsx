"use client";

import { useState, useTransition } from "react";

import { setToolEnabled } from "./actions";

/**
 * Turns a tool on or off everywhere at once.
 *
 * Saves on change, like assigning a number: one switch, no form. Disabling
 * takes effect from the next call; a call already running keeps the tools it
 * started with.
 */
export function EnableToggle({ id, enabled, readOnly }: { id: string; enabled: boolean; readOnly: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await setToolEnabled(id, next);
      if (result.error) {
        setOn(!next);
        setError(result.error);
      }
    });
  }

  return (
    <span className="flex items-center gap-2">
      <input type="checkbox" checked={on} disabled={readOnly || pending} onChange={toggle} aria-label="Enabled" />
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
