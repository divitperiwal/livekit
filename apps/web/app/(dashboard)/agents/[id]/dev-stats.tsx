"use client";

/**
 * What the worker reports about a test call while it runs.
 *
 * The worker publishes a snapshot about once a second on the room's data
 * channel (topic `automitra.stats`, see worker/live_stats.py). Nothing here is
 * fetched: it is only what the agent already knows about its own call.
 */

export const STATS_TOPIC = "automitra.stats";

export type Turn = {
  at: number;
  eou?: number;
  llm?: number;
  tts?: number;
  total?: number;
  promptTokens?: number;
};

export type LiveStats = {
  t: number;
  models: { stt: string; llm: string; tts: string; speaker: string; sttLanguage: string };
  state: { agent: string; user: string };
  turns: {
    user: number;
    interruptions: number;
    recent: Turn[];
    summary: { turns: number; p50: number; p95: number; max: number; eou: number; llm: number; tts: number } | null;
  };
  llm: {
    requests: number;
    lastPromptTokens: number;
    lastCompletionTokens: number;
    promptTokens: number;
    completionTokens: number;
  };
  speech: { sttSeconds: number; ttsChars: number };
  cost: { stt: number; tts: number; llm: number; total: number };
  ceiling: {
    inrPerMin: number;
    limitInrPerMin: number;
    utilisation: number;
    tightened: boolean;
    skippedRequests: number;
    heldBackChars: number;
  };
  heard: { at: number; text: string; language: string }[];
  tools: { at: number; name: string; args: string; output: string }[];
};

const seconds = (value?: number) => (value === undefined ? "—" : `${(value * 1000).toFixed(0)} ms`);
const rupees = (value: number) => `₹${value.toFixed(value < 1 ? 3 : 2)}`;

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-0.5 font-mono text-sm tabular-nums">{value}</p>
      {note ? <p className="mt-0.5 text-[11px] text-neutral-500">{note}</p> : null}
    </div>
  );
}

function StatePill({ who, state }: { who: string; state: string }) {
  const active = state === "speaking" || state === "thinking";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        active
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
      }`}
    >
      {who}: {state}
    </span>
  );
}

export function DevStats({ stats, live }: { stats: LiveStats; live: boolean }) {
  const used = Math.min(stats.ceiling.utilisation, 1.5);
  const over = stats.ceiling.utilisation >= 1;
  const barColour = over ? "bg-red-500" : stats.ceiling.tightened ? "bg-amber-500" : "bg-emerald-500";

  return (
    <section className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-800" aria-label="Live call stats">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-xs font-medium uppercase tracking-wide text-neutral-500">
          Developer stats {live ? "· live" : "· last snapshot"}
        </h3>
        <StatePill who="agent" state={stats.state.agent} />
        <StatePill who="caller" state={stats.state.user} />
        <span className="font-mono text-xs text-neutral-500">t={stats.t.toFixed(0)}s</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label="Cost so far"
          value={rupees(stats.cost.total)}
          note={`stt ${rupees(stats.cost.stt)} · tts ${rupees(stats.cost.tts)} · llm ${rupees(stats.cost.llm)}`}
        />
        <Tile
          label="Rate"
          value={`₹${stats.ceiling.inrPerMin.toFixed(2)}/min`}
          note={`limit ₹${stats.ceiling.limitInrPerMin.toFixed(2)}/min`}
        />
        <Tile
          label="Reply latency"
          value={stats.turns.summary ? `p50 ${seconds(stats.turns.summary.p50)}` : "—"}
          note={stats.turns.summary ? `p95 ${seconds(stats.turns.summary.p95)} · max ${seconds(stats.turns.summary.max)}` : "no full turn yet"}
        />
        <Tile
          label="LLM"
          value={`${stats.llm.requests} req · ${stats.llm.lastPromptTokens} tok`}
          note={`total ${stats.llm.promptTokens} in / ${stats.llm.completionTokens} out`}
        />
      </div>

      <div className="mt-3">
        <div className="flex justify-between text-[11px] text-neutral-500">
          <span>Cost ceiling used {(stats.ceiling.utilisation * 100).toFixed(0)}%</span>
          <span>
            {stats.ceiling.tightened ? "agent told to be brief · " : ""}
            {stats.ceiling.skippedRequests} replies skipped · {stats.ceiling.heldBackChars} chars held back
          </span>
        </div>
        <div className="mt-1 h-1.5 rounded bg-neutral-100 dark:bg-neutral-900">
          <div className={`h-1.5 rounded ${barColour}`} style={{ width: `${(used / 1.5) * 100}%` }} />
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left font-mono text-xs tabular-nums">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1 pr-3 font-normal">at</th>
              <th className="py-1 pr-3 font-normal">end of turn</th>
              <th className="py-1 pr-3 font-normal">LLM first token</th>
              <th className="py-1 pr-3 font-normal">TTS first audio</th>
              <th className="py-1 pr-3 font-normal">caller waited</th>
              <th className="py-1 font-normal">prompt tok</th>
            </tr>
          </thead>
          <tbody>
            {stats.turns.recent.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-1 text-neutral-500">No turns yet.</td>
              </tr>
            ) : (
              stats.turns.recent.map((turn) => (
                <tr key={turn.at} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td className="py-1 pr-3">{turn.at.toFixed(0)}s</td>
                  <td className="py-1 pr-3">{seconds(turn.eou)}</td>
                  <td className="py-1 pr-3">{seconds(turn.llm)}</td>
                  <td className="py-1 pr-3">{seconds(turn.tts)}</td>
                  <td className={`py-1 pr-3 ${turn.total !== undefined && turn.total > 2 ? "text-red-600" : ""}`}>
                    {seconds(turn.total)}
                  </td>
                  <td className="py-1">{turn.promptTokens ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-neutral-500">
            Heard ({stats.turns.user} turns · {stats.turns.interruptions} interruptions)
          </p>
          <ul className="mt-1 space-y-1 text-xs">
            {stats.heard.length === 0 ? <li className="text-neutral-500">Nothing yet.</li> : null}
            {stats.heard.map((h) => (
              <li key={`${h.at}-${h.text}`}>
                <span className="font-mono text-neutral-500">{h.at.toFixed(0)}s {h.language}</span> {h.text}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-neutral-500">Tool calls</p>
          <ul className="mt-1 space-y-1 text-xs">
            {stats.tools.length === 0 ? <li className="text-neutral-500">None yet.</li> : null}
            {stats.tools.map((tool) => (
              <li key={`${tool.at}-${tool.name}`} className="break-words">
                <span className="font-mono text-neutral-500">{tool.at.toFixed(0)}s</span>{" "}
                <span className="font-mono">{tool.name}</span> {tool.args}
                <span className="block text-neutral-500">→ {tool.output}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-3 font-mono text-[11px] text-neutral-500">
        {stats.models.stt} ({stats.models.sttLanguage}) · {stats.models.llm} · {stats.models.tts}/{stats.models.speaker} ·
        stt {stats.speech.sttSeconds}s · tts {stats.speech.ttsChars} chars
      </p>
    </section>
  );
}
