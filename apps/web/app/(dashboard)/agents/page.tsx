import Link from "next/link";

import { api, type AgentSummary } from "@/lib/api";
import { when } from "@/lib/format";

export const metadata = { title: "Agents" };

export default async function AgentsPage() {
  const { agents } = await api<{ agents: AgentSummary[] }>("/agents");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-neutral-500">
          What each one says, and which voice it says it in.
        </p>
      </div>

      {agents.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No agents yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                href={`/agents/${agent.id}`}
                className="block rounded-md border border-neutral-200 px-4 py-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{agent.name}</span>
                  <span className="font-mono text-xs text-neutral-500">{agent.slug}</span>
                  {!agent.liveVersionId ? (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      unpublished
                    </span>
                  ) : null}
                </div>
                {agent.description ? (
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {agent.description}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-neutral-400">
                  Updated {when(agent.updatedAt)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
