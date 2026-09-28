"use client";

import { useState, useTransition } from "react";

import type { Campaign } from "@/lib/api";

import { buttonClass, secondaryButtonClass } from "../../form";
import { changeCampaignStatus } from "../actions";

type Action = "start" | "pause" | "resume" | "cancel";

/** Which buttons a campaign in each state offers. */
const ACTIONS: Record<Campaign["status"], Action[]> = {
  draft: ["start", "cancel"],
  scheduled: ["start", "cancel"],
  running: ["pause", "cancel"],
  paused: ["resume", "cancel"],
  completed: [],
  cancelled: [],
};

const LABELS: Record<Action, string> = { start: "Start calling", pause: "Pause", resume: "Resume", cancel: "Cancel" };

export function CampaignControls({ id, status, readOnly }: { id: string; status: Campaign["status"]; readOnly: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: Action) {
    // Cancelling cannot be undone; everything else can.
    if (action === "cancel" && !window.confirm("Cancel this campaign? Nobody else on it will be called.")) return;
    setError(null);
    startTransition(async () => {
      const result = await changeCampaignStatus(id, action);
      if (result.error) setError(result.error);
    });
  }

  if (readOnly || ACTIONS[status].length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACTIONS[status].map((action) => (
        <button
          key={action}
          type="button"
          disabled={pending}
          onClick={() => run(action)}
          className={action === "start" || action === "resume" ? buttonClass : secondaryButtonClass}
        >
          {LABELS[action]}
        </button>
      ))}
      {error ? <span className="text-sm text-red-600">{error}</span> : null}
    </div>
  );
}
