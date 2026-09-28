import Link from "next/link";

import { api, type CallSummary } from "@/lib/api";
import { duration, phone, rupees, when } from "@/lib/format";

export const metadata = { title: "Calls" };

/** Colour by how the call ended, so a failing agent is visible at a glance. */
function statusStyle(status: string): string {
  if (status === "completed") return "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300";
  if (status === "in_progress" || status === "ringing")
    return "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300";
  return "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300";
}

export default async function CallsPage() {
  const { calls } = await api<{ calls: CallSummary[] }>("/calls?limit=100");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Calls</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {calls.length === 0
            ? "No calls yet."
            : `${calls.length} most recent.`}
        </p>
      </div>

      {calls.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Calls appear here as they happen, with the full transcript.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
                <th className="px-4 py-2 text-right font-medium">Duration</th>
                <th className="px-4 py-2 text-right font-medium">Charged</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr
                  key={call.id}
                  className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                >
                  <td className="px-4 py-2 whitespace-nowrap">
                    <Link href={`/calls/${call.id}`} className="underline-offset-4 hover:underline">
                      {when(call.startedAt)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                    {call.agentSlug ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {phone(call.direction === "inbound" ? call.fromNumber : call.toNumber)}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${statusStyle(call.status)}`}>
                      {call.status.replace(/_/g, " ")}
                    </span>
                    {call.endReason ? (
                      <span className="ml-2 text-xs text-neutral-500">{call.endReason}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                    {call.disposition ? <span className="font-mono">{call.disposition}</span> : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {duration(call.durationSeconds)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {rupees(call.priceInr)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
