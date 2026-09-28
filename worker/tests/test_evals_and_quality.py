"""Simulated-caller tests, latency and QA scoring.

The scenario runner is exercised end to end: a real ``AgentSession`` in text
mode, driven by a scripted model that plays the agent, the caller and the
judge. Only the model is fake; the session, the tool calls and the transcript
are the SDK's own.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from livekit.agents import APIConnectOptions, llm, metrics
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

from automitra_worker.analysis import build_prompt, parse_qa
from automitra_worker.config import AgentConfig
from automitra_worker.evals import END, Scenario, run_scenario
from automitra_worker.latency import LatencyTracker, percentile
from automitra_worker.tools import ToolSpec

Reply = str | llm.FunctionToolCall


class ScriptedLLM(llm.LLM):
    """A model whose every reply is decided by a function of the conversation."""

    def __init__(self, respond: Callable[[llm.ChatContext, list[Any]], Reply]) -> None:
        super().__init__()
        self.respond = respond

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[Any] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        **_: Any,
    ) -> llm.LLMStream:
        return _Stream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)


class _Stream(llm.LLMStream):
    async def _run(self) -> None:
        reply = self._llm.respond(self._chat_ctx, self._tools)  # type: ignore[attr-defined]
        if isinstance(reply, llm.FunctionToolCall):
            delta = llm.ChoiceDelta(role="assistant", tool_calls=[reply])
        else:
            delta = llm.ChoiceDelta(role="assistant", content=reply)
        self._event_ch.send_nowait(llm.ChatChunk(id="c", delta=delta))
        self._event_ch.send_nowait(
            llm.ChatChunk(id="c", usage=llm.CompletionUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15))
        )


def system_of(ctx: llm.ChatContext) -> str:
    for item in ctx.items:
        if getattr(item, "role", None) in ("system", "developer"):
            return item.text_content or ""
    return ""


def last_user(ctx: llm.ChatContext) -> str:
    users = [i for i in ctx.items if getattr(i, "role", None) == "user"]
    return (users[-1].text_content or "") if users else ""


CONFIG = AgentConfig.from_record(
    {"instructions": "You are Simran from KBS Motors, speaking to {{name}}.", "greeting": "Greet", "config": {}}
)
LOOKUP = ToolSpec(
    name="lookup_price",
    description="Look up a price",
    parameters={"type": "object", "properties": {"model": {"type": "string"}}},
    url="https://crm.example.com/price",
)


def test_percentiles() -> None:
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5
    assert percentile([5.0], 0.95) == 5.0
    assert percentile([], 0.5) == 0.0


def test_latency_joins_the_three_waits_of_a_turn() -> None:
    tracker = LatencyTracker()
    for sid, (eou, ttft, ttfb) in {"a": (0.4, 0.5, 0.3), "b": (0.6, 0.9, 0.5)}.items():
        tracker.collect(metrics.EOUMetrics(timestamp=0, end_of_utterance_delay=eou, transcription_delay=0, on_user_turn_completed_delay=0, speech_id=sid))
        tracker.collect(metrics.LLMMetrics(label="x", request_id="r", timestamp=0, duration=1, ttft=ttft, cancelled=False, completion_tokens=1, prompt_tokens=1, prompt_cached_tokens=0, total_tokens=2, tokens_per_second=1, speech_id=sid))
        tracker.collect(metrics.TTSMetrics(label="x", request_id="r", timestamp=0, ttfb=ttfb, duration=1, audio_duration=1, cancelled=False, characters_count=1, streamed=True, speech_id=sid))
    # The greeting: no end of utterance, so not a wait the caller sat through.
    tracker.collect(metrics.TTSMetrics(label="x", request_id="r", timestamp=0, ttfb=0.2, duration=1, audio_duration=1, cancelled=False, characters_count=1, streamed=True, speech_id="greeting"))

    summary = tracker.summary()
    assert summary is not None
    assert summary["turns"] == 2
    assert summary["p50"] == 1.6  # (1.2 + 2.0) / 2
    assert summary["max"] == 2.0
    assert summary["llm"] == 0.7


def test_no_complete_turn_means_no_figures() -> None:
    assert LatencyTracker().summary() is None


def test_qa_verdicts_follow_the_criteria() -> None:
    criteria = ("Confirmed the appointment time", "Did not quote a price")
    prompt = build_prompt("Caller: hi", ("interested",), (), criteria)
    assert '- "1": Confirmed the appointment time' in prompt
    assert parse_qa({"qa": {"1": True, "2": "false"}}, criteria) == (
        {"criterion": criteria[0], "passed": True},
        {"criterion": criteria[1], "passed": False},
    )
    # Missing or unclear is recorded as unknown, not as a pass.
    assert parse_qa({"qa": {"1": "maybe"}}, criteria)[0]["passed"] is None
    assert parse_qa({}, criteria)[1]["passed"] is None


async def test_a_scenario_plays_and_is_judged() -> None:
    calls: list[str] = []

    def agent(ctx: llm.ChatContext, tools: list[Any]) -> Reply:
        # The prompt reached the agent with the scenario's variable filled in.
        assert "speaking to Asha" in system_of(ctx)
        said = last_user(ctx)
        outputs = [i for i in ctx.items if getattr(i, "type", None) == "function_call_output"]
        if "Thar" in said and not outputs:
            calls.append("lookup_price")
            return llm.FunctionToolCall(name="lookup_price", arguments=json.dumps({"model": "Thar"}), call_id="t1")
        if outputs and "price" not in " ".join(i.text_content or "" for i in ctx.items if getattr(i, "role", None) == "assistant"):
            return "The Thar is 11.35 lakh ex-showroom."
        return "Namaste Asha ji, how can I help?"

    turns = iter(["Thar ka price kya hai?", END])

    def caller(ctx: llm.ChatContext, tools: list[Any]) -> Reply:
        if "has just connected" in last_user(ctx):
            return "Hello?"
        return next(turns)

    def judge(ctx: llm.ChatContext, tools: list[Any]) -> Reply:
        return json.dumps({"passed": "11.35" in last_user(ctx), "reasoning": "checked"})

    scenario = Scenario(
        id="s1",
        name="price",
        caller="A buyer asking about the Thar",
        criteria=("Gave the price",),
        variables={"name": "Asha"},
        tool_responses={"lookup_price": "11.35 lakh"},
    )
    result = await run_scenario(
        CONFIG,
        scenario,
        agent_model=ScriptedLLM(agent),
        caller_model=ScriptedLLM(caller),
        judge_model=ScriptedLLM(judge),
        tools=[LOOKUP],
    )

    assert result.error is None
    assert result.passed
    assert calls == ["lookup_price"]
    roles = [t["role"] for t in result.transcript]
    assert roles[0] == "caller" and "tool" in roles and "agent" in roles
    assert any("11.35" in t["text"] for t in result.transcript if t["role"] == "agent")
    assert result.tokens > 0


async def test_a_failed_criterion_fails_the_scenario() -> None:
    result = await run_scenario(
        CONFIG,
        Scenario(id="s2", name="x", caller="Someone", criteria=("Booked a test drive",), max_turns=1),
        agent_model=ScriptedLLM(lambda ctx, tools: "Hello."),
        caller_model=ScriptedLLM(lambda ctx, tools: "Hi"),
        judge_model=ScriptedLLM(lambda ctx, tools: '{"passed": false, "reasoning": "no booking"}'),
    )
    assert not result.passed
    assert result.judgments == [{"criterion": "Booked a test drive", "passed": False, "reasoning": "no booking"}]


async def test_a_judge_that_is_not_json_counts_as_a_fail() -> None:
    result = await run_scenario(
        CONFIG,
        Scenario(id="s3", name="x", caller="Someone", criteria=("Anything",), max_turns=1),
        agent_model=ScriptedLLM(lambda ctx, tools: "Hello."),
        caller_model=ScriptedLLM(lambda ctx, tools: "Hi"),
        judge_model=ScriptedLLM(lambda ctx, tools: "Looks fine to me!"),
    )
    assert result.judgments[0]["passed"] is False


async def test_the_agent_ending_the_call_ends_the_scenario() -> None:
    caller_lines: list[str] = []

    def caller(ctx: llm.ChatContext, tools: list[Any]) -> Reply:
        caller_lines.append("line")
        return "Bye"

    ended_once = {"done": False}

    def agent(ctx: llm.ChatContext, tools: list[Any]) -> Reply:
        if not ended_once["done"]:
            ended_once["done"] = True
            return llm.FunctionToolCall(name="end_call", arguments="{}", call_id="e1")
        return "Goodbye!"

    result = await run_scenario(
        CONFIG,
        Scenario(id="s4", name="x", caller="Someone", criteria=(), max_turns=6),
        agent_model=ScriptedLLM(agent),
        caller_model=ScriptedLLM(caller),
        judge_model=ScriptedLLM(lambda ctx, tools: "{}"),
    )
    assert result.turns == 1
    # The opener, and no second line: the call was over.
    assert len(caller_lines) == 1
    # No criteria means nothing failed.
    assert result.passed
