import Link from "next/link";

import { api, type AgentSummary, type Analytics } from "@/lib/api";
import { duration, rupees } from "@/lib/format";

import { cellClass, Empty, rowClass, Table } from "../form";

export const metadata = { title: "Analytics" };

const PERIODS = [7, 30, 90];

// One hue for magnitude, checked against both surfaces; values and labels
// stay in text ink, never in the bar colour.
const BAR = "bg-blue-600 dark:bg-blue-500";

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);
const secs = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(2)}s`);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {note ? <p className="mt-0.5 text-xs text-neutral-500">{note}</p> : null}
    </div>
  );
}

/** Horizontal bars for a breakdown: label, bar, value -- the value always in text. */
function Bars({ rows }: { rows: Array<{ label: string; value: number; title?: string }> }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-sm" title={row.title ?? `${row.label}: ${row.value}`}>
          <span className="truncate font-mono text-xs">{row.label}</span>
          <span className="h-2 rounded-r bg-neutral-100 dark:bg-neutral-800">
            <span className={`block h-2 rounded-r ${BAR}`} style={{ width: `${(row.value / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; agentId?: string }>;
}) {
  const params = await searchParams;
  const days = PERIODS.includes(Number(params.days)) ? Number(params.days) : 30;
  const query = new URLSearchParams({ days: String(days), ...(params.agentId ? { agentId: params.agentId } : {}) });
  const [data, { agents }] = await Promise.all([
    api<Analytics>(`/analytics?${query}`),
    api<{ agents: AgentSummary[] }>("/agents"),
  ]);
  const { totals } = data;
  const link = (next: Record<string, string | undefined>) => {
    const merged = { days: String(days), agentId: params.agentId, ...next };
    return `/analytics?${new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as [string, string][])}`;
  };
  const maxDaily = Math.max(...data.daily.map((d) => d.calls), 1);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-neutral-500">What your calls add up to, over the last {days} days.</p>
      </div>

      {/* Filters sit in one row above everything they filter. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {PERIODS.map((p) => (
          <Link key={p} href={link({ days: String(p) })} className={`rounded px-2 py-1 ${p === days ? "bg-neutral-100 dark:bg-neutral-800" : "text-neutral-500"}`}>
            {p} days
          </Link>
        ))}
        <span className="mx-2 text-neutral-300">|</span>
        <Link href={link({ agentId: undefined })} className={`rounded px-2 py-1 ${!params.agentId ? "bg-neutral-100 dark:bg-neutral-800" : "text-neutral-500"}`}>
          All agents
        </Link>
        {agents.map((a) => (
          <Link key={a.id} href={link({ agentId: a.id })} className={`rounded px-2 py-1 ${params.agentId === a.id ? "bg-neutral-100 dark:bg-neutral-800" : "text-neutral-500"}`}>
            {a.name}
          </Link>
        ))}
      </div>

      {totals.calls === 0 ? (
        <Empty>No calls in this period.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Calls" value={totals.calls.toLocaleString("en-IN")} note={`${totals.inbound} in · ${totals.outbound} out`} />
            <Stat label="Answer rate" value={pct(totals.answerRate)} note={`of outbound · ${totals.voicemail} voicemail`} />
            <Stat label="Average length" value={duration(Math.round(totals.avgDurationSeconds))} note={`${totals.transferred} transferred`} />
            <Stat label="Reply latency" value={secs(totals.latencyP50)} note={`median · p95 ${secs(totals.latencyP95)}`} />
          </div>

          <div className="grid gap-8 sm:grid-cols-2">
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Outcomes</h2>
              {data.dispositions.length === 0 ? (
                <p className="text-sm text-neutral-500">No analysed calls yet.</p>
              ) : (
                <Bars rows={data.dispositions.map((d) => ({ label: d.disposition, value: d.calls }))} />
              )}
            </section>
            <section className="space-y-3">
              <h2 className="text-sm font-medium">How calls ended</h2>
              <Bars
                rows={data.endReasons.map((r) => ({
                  label: r.endReason ? `${r.status} · ${r.endReason}` : r.status,
                  value: r.calls,
                }))}
              />
            </section>
          </div>

          <section className="space-y-3">
            <h2 className="text-sm font-medium">Calls per day</h2>
            <div className="flex h-28 items-end gap-0.5" role="img" aria-label="Calls per day">
              {data.daily.map((d) => (
                <div
                  key={d.day}
                  title={`${d.day}: ${d.calls} calls, ${d.answered} answered`}
                  className={`min-w-1 flex-1 rounded-t ${BAR}`}
                  style={{ height: `${Math.max((d.calls / maxDaily) * 100, 2)}%` }}
                />
              ))}
            </div>
            <p className="text-xs text-neutral-500">
              {data.daily[0]?.day} to {data.daily.at(-1)?.day} · hover a bar for the day&apos;s figures
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium">By agent version</h2>
            <p className="text-sm text-neutral-500">
              How an experiment is read: the same measures for each version that took calls.
            </p>
            <Table head={["Version", "Calls", "Answered", "Avg length", "Latency p50", "QA pass", "Outcomes"]}>
              {data.versions.map((v) => (
                <tr key={v.agentVersionId ?? "none"} className={rowClass}>
                  <td className={cellClass}>{v.version ? `v${v.version}` : "—"}</td>
                  <td className={`${cellClass} tabular-nums`}>{v.calls}</td>
                  <td className={`${cellClass} tabular-nums`}>{v.answered}</td>
                  <td className={`${cellClass} tabular-nums`}>{duration(Math.round(v.avgDurationSeconds))}</td>
                  <td className={`${cellClass} tabular-nums`}>{secs(v.latencyP50)}</td>
                  <td className={`${cellClass} tabular-nums`}>{pct(v.qaPassRate)}</td>
                  <td className={`${cellClass} text-xs text-neutral-500`}>
                    {Object.entries(v.dispositions ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, n]) => `${k} ${n}`)
                      .join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </Table>
          </section>

          <p className="text-xs text-neutral-500">
            Charged {rupees(totals.priceInr)} · cost {rupees(totals.costInr)} over the period.
          </p>
        </>
      )}
    </div>
  );
}
