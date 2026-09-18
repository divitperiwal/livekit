import { api, type AgentSummary, type Me, type PhoneNumber } from "@/lib/api";

import { AssignAgent } from "./assign";

export const metadata = { title: "Numbers" };

export default async function NumbersPage() {
  const [{ numbers }, { agents }, me] = await Promise.all([
    api<{ numbers: PhoneNumber[] }>("/numbers"),
    api<{ agents: AgentSummary[] }>("/agents"),
    api<Me>("/me"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Numbers</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Which agent answers when someone calls.
        </p>
      </div>

      {numbers.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No numbers assigned to you yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Direction</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Answered by</th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((number) => (
                <tr
                  key={number.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-800"
                >
                  <td className="px-4 py-2 font-mono">{number.e164}</td>
                  <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                    {number.direction}
                  </td>
                  <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                    {number.status}
                  </td>
                  <td className="px-4 py-2">
                    <AssignAgent
                      numberId={number.id}
                      agentId={number.agentId}
                      agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                      readOnly={me.role === "viewer"}
                    />
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
