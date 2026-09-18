import { api, type Usage } from "@/lib/api";
import { duration, rupees } from "@/lib/format";

export const metadata = { title: "Usage" };

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: "warn" | "bad";
  note?: string;
}) {
  const colour =
    tone === "bad"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "";

  return (
    <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${colour}`}>{value}</div>
      {note ? <div className="mt-1 text-xs text-neutral-500">{note}</div> : null}
    </div>
  );
}

export default async function UsagePage() {
  const usage = await api<Usage>("/usage?days=30");

  const totals = usage.daily.reduce(
    (sum, day) => ({
      calls: sum.calls + day.calls,
      seconds: sum.seconds + day.seconds,
      cost: sum.cost + Number(day.costInr),
      price: sum.price + Number(day.priceInr),
    }),
    { calls: 0, seconds: 0, cost: 0, price: 0 },
  );

  const margin = totals.price - totals.cost;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
        <p className="mt-1 text-sm text-neutral-500">The last 30 days.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Balance"
          value={rupees(usage.balanceInr)}
          tone={usage.canPlaceCalls ? undefined : "bad"}
          note={
            usage.canPlaceCalls
              ? undefined
              : "Calls are being refused until this is topped up."
          }
        />
        <Stat label="Calls" value={String(totals.calls)} />
        <Stat label="Talk time" value={duration(totals.seconds)} />
        <Stat
          label="Charged"
          value={rupees(totals.price)}
          note={`cost ${rupees(totals.cost)} · margin ${rupees(margin)}`}
          // A negative margin is the number worth noticing on this page.
          tone={margin < 0 ? "bad" : undefined}
        />
      </div>

      {usage.needsReview > 0 ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {usage.needsReview} {usage.needsReview === 1 ? "call" : "calls"} could not
          be priced and need a look. They were still recorded, so nothing is lost —
          they can be repriced once the rate card covers them.
        </p>
      ) : null}

      {usage.daily.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No usage in this period.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2 font-medium">Day</th>
                <th className="px-4 py-2 text-right font-medium">Calls</th>
                <th className="px-4 py-2 text-right font-medium">Talk time</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Charged</th>
                <th className="px-4 py-2 text-right font-medium">Margin</th>
              </tr>
            </thead>
            <tbody>
              {usage.daily.map((day) => {
                const dayMargin = Number(day.priceInr) - Number(day.costInr);
                return (
                  <tr
                    key={day.day}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-800"
                  >
                    <td className="px-4 py-2">{day.day}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.calls}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {duration(day.seconds)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-500">
                      {rupees(day.costInr)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {rupees(day.priceInr)}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${
                        dayMargin < 0 ? "text-red-600 dark:text-red-400" : ""
                      }`}
                    >
                      {rupees(dayMargin)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
