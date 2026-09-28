import type { Campaign, ContactStatus } from "@/lib/api";

const CAMPAIGN_STYLES: Record<Campaign["status"], string> = {
  draft: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  scheduled: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  running: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  paused: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  cancelled: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

export function CampaignStatus({ status }: { status: Campaign["status"] }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs ${CAMPAIGN_STYLES[status]}`}>{status}</span>;
}

/** The order contact states are shown in: what is left, then how it went. */
export const CONTACT_STATES: ContactStatus[] = ["pending", "dialing", "completed", "exhausted", "failed", "suppressed"];

/** "12 of 40 done" -- finished contacts over all of them. */
export function progress(counts: Partial<Record<ContactStatus, number>>): string {
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  if (total === 0) return "no contacts";
  const done = total - (counts.pending ?? 0) - (counts.dialing ?? 0);
  return `${done} of ${total} done`;
}
