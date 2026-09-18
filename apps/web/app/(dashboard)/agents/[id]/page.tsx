import Link from "next/link";
import { notFound } from "next/navigation";

import { api, ApiError, type AgentSummary, type AgentVersion, type Me } from "@/lib/api";
import { when } from "@/lib/format";
import { commonTimezones, options, speakersFor, ttsModels } from "@/lib/schema";

import { AgentEditor } from "./editor";

export const metadata = { title: "Agent" };

interface AgentDetail {
  agent: AgentSummary;
  versions: Array<{ id: string; version: number; publishedAt: string | null }>;
  live: AgentVersion | null;
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: AgentDetail;
  let me: Me;
  try {
    [detail, me] = await Promise.all([
      api<AgentDetail>(`/agents/${id}`),
      api<Me>("/me"),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { agent, versions, live } = detail;

  // The options come from the same generated schema the API validates against,
  // so a dropdown cannot offer a value the worker would reject.
  const choices = {
    sttModels: options("stt_model"),
    sttModes: options("stt_mode"),
    llmModels: options("llm_model"),
    ttsModels: ttsModels(),
    ttsLanguages: options("tts_language"),
    speakersByModel: Object.fromEntries(
      ttsModels().map((model) => [model, speakersFor(model)]),
    ),
    timezones: commonTimezones(),
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/agents"
          className="text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          ← Agents
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{agent.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          <span className="font-mono text-xs">{agent.slug}</span>
          {live ? (
            <>
              {" · "}live v{live.version}
              {live.publishedAt ? ` · published ${when(live.publishedAt)}` : null}
            </>
          ) : (
            " · never published"
          )}
        </p>
      </div>

      {versions.length > 1 ? (
        <p className="text-xs text-neutral-500">
          {versions.length} versions. Publishing writes a new one and leaves the
          old readable, so every past call still names the configuration that
          produced it.
        </p>
      ) : null}

      <AgentEditor
        agentId={agent.id}
        live={live}
        choices={choices}
        readOnly={me.role === "viewer"}
      />
    </div>
  );
}
