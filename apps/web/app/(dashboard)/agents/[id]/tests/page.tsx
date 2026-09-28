import Link from "next/link";
import { notFound } from "next/navigation";

import { api, ApiError, type AgentSummary, type EvalResult, type EvalRun, type Me, type Scenario } from "@/lib/api";
import { when } from "@/lib/format";

import { Empty } from "../../../form";
import { AddScenario, DeleteScenario, RunSuite } from "./forms";

export const metadata = { title: "Test suite" };

const STATUS_STYLE: Record<EvalRun["status"], string> = {
  queued: "text-neutral-500",
  running: "text-blue-700 dark:text-blue-300",
  completed: "text-neutral-700 dark:text-neutral-300",
  failed: "text-red-600",
};

function Result({ result }: { result: EvalResult }) {
  return (
    <details className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <summary className="cursor-pointer text-sm">
        <span className={result.passed ? "text-green-700 dark:text-green-400" : "text-red-600"}>
          {result.passed ? "✓ passed" : "✗ failed"}
        </span>{" "}
        {result.scenarioName}
        <span className="ml-2 text-xs text-neutral-500">{result.turns} turns</span>
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        {result.error ? <p className="text-red-600">{result.error}</p> : null}
        <ul className="space-y-1">
          {result.judgments.map((j) => (
            <li key={j.criterion}>
              <span className={j.passed ? "text-green-700 dark:text-green-400" : "text-red-600"}>{j.passed ? "✓" : "✗"}</span>{" "}
              {j.criterion} <span className="text-xs text-neutral-500">— {j.reasoning}</span>
            </li>
          ))}
        </ul>
        <div className="space-y-1 rounded bg-neutral-50 p-3 text-xs dark:bg-neutral-900">
          {result.transcript.map((t, i) => (
            <p key={i} className={t.role === "tool" ? "font-mono text-neutral-500" : ""}>
              <span className="font-medium">{t.role === "caller" ? "Caller" : t.role === "agent" ? "Agent" : "Tool"}:</span> {t.text}
            </p>
          ))}
        </div>
      </div>
    </details>
  );
}

export default async function TestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const { run: runId } = await searchParams;

  let agent: AgentSummary;
  let versions: Array<{ id: string; version: number }>;
  let scenarios: Scenario[];
  let runs: EvalRun[];
  let me: Me;
  try {
    [{ agent, versions }, { scenarios }, { runs }, me] = await Promise.all([
      api<{ agent: AgentSummary; versions: Array<{ id: string; version: number }> }>(`/agents/${id}`),
      api<{ scenarios: Scenario[] }>(`/agents/${id}/scenarios`),
      api<{ runs: EvalRun[] }>(`/agents/${id}/eval-runs`),
      api<Me>("/me"),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const shown = runId ?? runs[0]?.id;
  const detail = shown ? await api<{ run: EvalRun; results: EvalResult[] }>(`/eval-runs/${shown}`).catch(() => null) : null;
  const readOnly = me.role === "viewer";

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/agents/${id}`} className="text-sm text-neutral-500 underline-offset-4 hover:underline">
          ← {agent.name}
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Test suite</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Simulated callers, played against a version in text before real callers meet it. Tools are not called:
          each answers with the scenario&apos;s canned response. A run takes a minute or two.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Scenarios</h2>
        {scenarios.length === 0 ? (
          <Empty>No scenarios yet. Add the calls this agent must handle well.</Empty>
        ) : (
          <ul className="space-y-2">
            {scenarios.map((s) => (
              <li key={s.id} className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-neutral-600 dark:text-neutral-400">{s.caller}</p>
                    <ul className="mt-1 list-inside list-disc text-xs text-neutral-500">
                      {s.criteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                  {readOnly ? null : <DeleteScenario agentId={id} scenarioId={s.id} />}
                </div>
              </li>
            ))}
          </ul>
        )}
        {readOnly || scenarios.length === 0 ? null : (
          <RunSuite agentId={id} versions={versions} liveVersionId={agent.liveVersionId} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-neutral-500">No runs yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-3">
                <Link href={`/agents/${id}/tests?run=${r.id}`} className={`underline-offset-4 hover:underline ${r.id === shown ? "font-medium" : ""}`}>
                  {when(r.createdAt)}
                </Link>
                <span>v{r.version ?? "?"}</span>
                <span className={STATUS_STYLE[r.status]}>{r.status}</span>
                {r.total !== null ? (
                  <span className="tabular-nums">
                    {r.passed}/{r.total} passed
                  </span>
                ) : null}
                {r.error ? <span className="text-xs text-red-600">{r.error.slice(0, 160)}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {detail ? (
          <div className="space-y-2">
            {detail.results.length === 0 ? (
              <p className="text-sm text-neutral-500">
                {detail.run.status === "failed" ? "The run did not complete." : "Results appear here as each scenario finishes; refresh to update."}
              </p>
            ) : (
              detail.results.map((r) => <Result key={r.id} result={r} />)
            )}
          </div>
        ) : null}
      </section>

      {readOnly ? null : (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Add a scenario</h2>
          <AddScenario agentId={id} />
        </section>
      )}
    </div>
  );
}
