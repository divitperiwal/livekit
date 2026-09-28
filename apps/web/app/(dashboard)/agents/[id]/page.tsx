import Link from "next/link";
import { notFound } from "next/navigation";

import {
  api,
  ApiError,
  type AgentSummary,
  type AgentVersion,
  type KnowledgeBase,
  type Me,
  type Tool,
} from "@/lib/api";
import { when } from "@/lib/format";
import { commonTimezones, options, speakersFor, ttsModels } from "@/lib/schema";

import { ExperimentForm } from "../agent-forms";
import { AgentEditor } from "./editor";
import { TestCall } from "./test-call";

export const metadata = { title: "Agent" };

interface AgentDetail {
  agent: AgentSummary;
  versions: Array<{ id: string; version: number; publishedAt: string | null }>;
  live: AgentVersion | null;
  toolIds: string[];
  knowledgeBaseIds: string[];
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: AgentDetail;
  let me: Me;
  let tools: Tool[];
  let knowledgeBases: KnowledgeBase[];
  try {
    [detail, me, { tools }, { knowledgeBases }] = await Promise.all([
      api<AgentDetail>(`/agents/${id}`),
      api<Me>("/me"),
      api<{ tools: Tool[] }>("/tools"),
      api<{ knowledgeBases: KnowledgeBase[] }>("/knowledge-bases"),
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
    fallbackLlms: options("fallback_llm"),
    fallbackStts: options("fallback_stt"),
    fallbackTtss: options("fallback_tts"),
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

      {live ? <TestCall agentId={agent.id} /> : null}

      <div className="flex flex-wrap gap-4 text-sm">
        <Link href={`/agents/${agent.id}/tests`} className="underline-offset-4 hover:underline">
          Test suite →
        </Link>
        <Link href={`/analytics?agentId=${agent.id}`} className="underline-offset-4 hover:underline">
          Analytics →
        </Link>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Experiment</h2>
        <ExperimentForm
          agentId={agent.id}
          liveVersionId={agent.liveVersionId}
          candidateVersionId={agent.candidateVersionId ?? null}
          candidatePercent={agent.candidatePercent ?? 0}
          versions={versions}
          readOnly={me.role === "viewer"}
        />
      </section>

      <AgentEditor
        agentId={agent.id}
        live={live}
        choices={choices}
        tools={tools}
        toolIds={detail.toolIds}
        knowledgeBases={knowledgeBases}
        knowledgeBaseIds={detail.knowledgeBaseIds}
        readOnly={me.role === "viewer"}
      />
    </div>
  );
}
