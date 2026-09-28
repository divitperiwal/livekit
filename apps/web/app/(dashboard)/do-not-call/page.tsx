import Link from "next/link";

import { api, type Me, type Suppression } from "@/lib/api";
import { when } from "@/lib/format";

import { cellClass, Empty, rowClass, Table } from "../form";
import { AddNumbers, RemoveNumber } from "./forms";

export const metadata = { title: "Do not call" };

const SOURCES: Record<string, string> = {
  call: "Asked on a call",
  manual: "Added here",
  upload: "Uploaded",
};

export default async function DoNotCallPage() {
  const [{ suppressions }, me] = await Promise.all([
    api<{ suppressions: Suppression[] }>("/suppressions"),
    api<Me>("/me"),
  ]);
  const readOnly = me.role === "viewer";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Do not call</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Numbers no campaign of yours will call. A caller who asks the agent not to call again is added
          automatically. This is your own list; the national DND registry is separate and is not checked here.
        </p>
      </div>

      {suppressions.length === 0 ? (
        <Empty>Nobody on the list.</Empty>
      ) : (
        <Table head={["Number", "How", "Reason", "Added", ""]}>
          {suppressions.map((entry) => (
            <tr key={entry.id} className={rowClass}>
              <td className={`${cellClass} font-mono text-xs`}>{entry.e164}</td>
              <td className={cellClass}>
                {entry.callId ? (
                  <Link href={`/calls/${entry.callId}`} className="underline-offset-4 hover:underline">
                    {SOURCES[entry.source] ?? entry.source}
                  </Link>
                ) : (
                  (SOURCES[entry.source] ?? entry.source)
                )}
              </td>
              <td className={`${cellClass} text-neutral-600 dark:text-neutral-400`}>{entry.reason ?? "—"}</td>
              <td className={`${cellClass} whitespace-nowrap text-neutral-500`}>{when(entry.createdAt)}</td>
              <td className={cellClass}>{readOnly ? null : <RemoveNumber id={entry.id} />}</td>
            </tr>
          ))}
        </Table>
      )}

      {readOnly ? null : (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Add numbers</h2>
          <AddNumbers />
        </section>
      )}
    </div>
  );
}
