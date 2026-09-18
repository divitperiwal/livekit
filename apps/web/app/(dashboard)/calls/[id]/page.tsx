import Link from "next/link";
import { notFound } from "next/navigation";

import { api, ApiError, type CallEvent, type CallSummary, type UsageRecord } from "@/lib/api";
import { duration, phone, rupees, timeOnly, when } from "@/lib/format";

export const metadata = { title: "Call" };

interface CallDetail {
  call: CallSummary & { lkRoomName: string; agentVersionId: string | null };
  events: CallEvent[];
  usage: UsageRecord | null;
}

/** A transcript turn. Who said it decides which side it sits on. */
function Turn({ event }: { event: CallEvent }) {
  const isUser = event.type === "user_message";
  const interrupted = Boolean(event.payload?.interrupted);

  return (
    <div className={isUser ? "flex justify-start" : "flex justify-end"}>
      <div className="max-w-[75%] space-y-1">
        <div
          className={
            isUser
              ? "rounded-lg rounded-tl-none bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800"
              : "rounded-lg rounded-tr-none bg-blue-50 px-3 py-2 text-sm dark:bg-blue-950"
          }
        >
          {event.content}
        </div>
        <div
          className={`flex gap-2 text-xs text-neutral-400 ${isUser ? "" : "justify-end"}`}
        >
          <span>{isUser ? "caller" : "agent"}</span>
          <span>{timeOnly(event.at)}</span>
          {/* Worth surfacing: a call full of these usually means the
              endpointing is too eager, which the words alone do not show. */}
          {interrupted ? <span className="text-amber-600">interrupted</span> : null}
        </div>
      </div>
    </div>
  );
}

/** Anything that is not speech: a tool call, an error, a budget stage. */
function Marker({ event }: { event: CallEvent }) {
  const tone =
    event.type === "error"
      ? "text-red-600 dark:text-red-400"
      : "text-neutral-500";

  return (
    <div className="flex justify-center">
      <div className={`flex items-center gap-2 text-xs ${tone}`}>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-800">
          {event.type.replace(/_/g, " ")}
        </span>
        {event.content ? <span>{event.content}</span> : null}
        <span className="text-neutral-400">{timeOnly(event.at)}</span>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{children}</dd>
    </div>
  );
}

export default async function CallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Route params are a promise in this version of Next.
  const { id } = await params;

  let detail: CallDetail;
  try {
    detail = await api<CallDetail>(`/calls/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { call, events, usage } = detail;
  const spoken = events.filter(
    (e) => e.type === "user_message" || e.type === "agent_message",
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/calls"
          className="text-sm text-neutral-500 underline-offset-4 hover:underline"
        >
          ← Calls
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          {phone(call.direction === "inbound" ? call.fromNumber : call.toNumber)}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {call.direction} · {call.agentSlug ?? "unknown agent"} · {when(call.startedAt)}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-md border border-neutral-200 p-4 sm:grid-cols-4 dark:border-neutral-800">
        <Field label="Status">
          {call.status.replace(/_/g, " ")}
          {call.endReason ? (
            <span className="ml-1 text-neutral-500">({call.endReason})</span>
          ) : null}
        </Field>
        <Field label="Duration">{duration(call.durationSeconds)}</Field>
        <Field label="Charged">{rupees(call.priceInr)}</Field>
        <Field label="Cost">
          {rupees(call.costInr)}
          {usage?.needsReview ? (
            <span
              className="ml-1 text-amber-600"
              title={usage.reviewReason ?? "needs review"}
            >
              ⚠
            </span>
          ) : null}
        </Field>
      </dl>

      {usage ? (
        <dl className="grid grid-cols-2 gap-4 rounded-md border border-neutral-200 p-4 text-neutral-600 sm:grid-cols-4 dark:border-neutral-800 dark:text-neutral-400">
          <Field label="Speech in">{Number(usage.sttSeconds).toFixed(0)}s</Field>
          <Field label="Speech out">{usage.ttsCharacters.toLocaleString()} chars</Field>
          <Field label="Tokens in">
            {usage.llmPromptTokens.toLocaleString()}
            {usage.llmCachedTokens > 0 ? (
              <span className="text-neutral-400">
                {" "}
                ({usage.llmCachedTokens.toLocaleString()} cached)
              </span>
            ) : null}
          </Field>
          <Field label="Tokens out">{usage.llmCompletionTokens.toLocaleString()}</Field>
        </dl>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          Transcript
          <span className="ml-2 font-normal text-neutral-500">
            {spoken.length} {spoken.length === 1 ? "turn" : "turns"}
          </span>
        </h2>

        {events.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
            Nothing was recorded for this call.
          </p>
        ) : (
          <div className="space-y-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            {events.map((event) =>
              event.type === "user_message" || event.type === "agent_message" ? (
                <Turn key={event.id} event={event} />
              ) : (
                <Marker key={event.id} event={event} />
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
}
