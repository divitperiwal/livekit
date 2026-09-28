"""Testing an agent against simulated callers, before real ones meet it.

A scenario describes a caller -- who they are, what they want, how they
behave -- and what a good call with them looks like. The runner has the
language model play that caller against the agent, turn by turn, in text: the
same prompt, tools and model as a live call, minus the phone line. Then a
judge reads the conversation and decides, criterion by criterion, whether the
agent did what it should.

Text rather than audio on purpose. What goes wrong with a prompt -- it forgets
to confirm the time, quotes a price it should not, loops on a question -- is
visible in the words, and a text run takes seconds and costs a few thousand
tokens rather than a phone call.

Customer tools are not called. A test of a booking agent must not book
anything, so each tool answers with the scenario's canned response, or a note
that it succeeded. The knowledge base is read for real, since reading it
changes nothing.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from livekit.agents import AgentSession, RunContext, function_tool
from livekit.agents import llm as lk_llm
from livekit.agents.llm import RawFunctionTool, StopResponse

from .analysis import _extract_json
from .config import AgentConfig
from .tools import ToolSpec

logger = logging.getLogger("automitra.evals")

SCENARIO_TIMEOUT_SECONDS = 180.0
END = "[END]"

CALLER_SYSTEM = (
    "You are role-playing a person on a phone call with a business's AI agent, "
    "to test it. Stay in character. Speak as that person would on the phone: "
    "short, natural sentences, in the language and style described. Reply with "
    "only what the person says next -- no narration, no quotation marks. When "
    f"the person would hang up, reply with exactly {END}."
)

JUDGE_SYSTEM = (
    "You judge whether an AI phone agent met a requirement in a conversation. "
    "Be strict: only what is in the transcript counts. Reply with JSON only: "
    '{"passed": true or false, "reasoning": "one sentence"}.'
)


@dataclass(frozen=True)
class Scenario:
    id: str
    name: str
    # Who the caller is and what they want: "A farmer from Ambala asking the
    # on-road price of a Thar; speaks Hindi; interrupts often."
    caller: str
    criteria: tuple[str, ...]
    max_turns: int = 8
    variables: dict[str, str] = field(default_factory=dict)
    # What each customer tool answers in this scenario, by tool name.
    tool_responses: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_json(cls, body: dict[str, Any]) -> Scenario:
        return cls(
            id=str(body["id"]),
            name=str(body.get("name") or ""),
            caller=str(body.get("caller") or ""),
            criteria=tuple(str(c) for c in body.get("criteria") or []),
            max_turns=int(body.get("maxTurns") or 8),
            variables={str(k): str(v) for k, v in (body.get("variables") or {}).items()},
            tool_responses={str(k): str(v) for k, v in (body.get("toolResponses") or {}).items()},
        )


@dataclass
class ScenarioResult:
    scenario_id: str
    passed: bool
    transcript: list[dict[str, str]]
    judgments: list[dict[str, Any]]
    turns: int
    error: str | None = None
    tokens: int = 0

    def as_payload(self) -> dict[str, Any]:
        return {
            "scenarioId": self.scenario_id,
            "passed": self.passed,
            "transcript": self.transcript,
            "judgments": self.judgments,
            "turns": self.turns,
            "error": self.error,
            "tokens": self.tokens,
        }


@dataclass
class _Tokens:
    count: int = 0


async def complete(model: lk_llm.LLM, system: str, user: str, tokens: _Tokens) -> str:
    """One non-streamed answer from a model, counting what it cost."""
    chat = lk_llm.ChatContext.empty()
    chat.add_message(role="system", content=system)
    chat.add_message(role="user", content=user)
    text = ""
    async with model.chat(chat_ctx=chat) as stream:
        async for chunk in stream:
            if chunk.delta and chunk.delta.content:
                text += chunk.delta.content
            if chunk.usage:
                tokens.count += chunk.usage.prompt_tokens + chunk.usage.completion_tokens
    return text.strip()


def _render(transcript: list[dict[str, str]]) -> str:
    return "\n".join(f"{'Caller' if t['role'] == 'caller' else 'Agent'}: {t['text']}" for t in transcript)


def stub_tools(specs: list[ToolSpec], scenario: Scenario, ended: dict[str, bool]) -> list[RawFunctionTool]:
    """Stand-ins for the agent's tools that do nothing outside the test.

    Each keeps the real tool's name, description and schema, so the model
    decides to call it exactly as it would on a live call.
    """

    def stub(spec: ToolSpec) -> RawFunctionTool:
        async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
            return scenario.tool_responses.get(
                spec.name, f"(test mode) {spec.name} succeeded with {json.dumps(raw_arguments)}"
            )

        return function_tool(
            handler,
            raw_schema={"name": spec.name, "description": spec.description, "parameters": spec.parameters},
        )

    async def end_call(raw_arguments: dict[str, object], context: RunContext) -> str:
        ended["ended"] = True
        return "Say a brief goodbye; the call ends after it."

    async def transfer_call(raw_arguments: dict[str, object], context: RunContext) -> None:
        ended["ended"] = True
        ended["transferred"] = True
        raise StopResponse()

    tools = [stub(spec) for spec in specs]
    tools.append(
        function_tool(
            end_call,
            raw_schema={
                "name": "end_call",
                "description": "End the phone call once the conversation is finished.",
                "parameters": {"type": "object", "properties": {"do_not_call": {"type": "boolean"}}},
            },
        )
    )
    tools.append(
        function_tool(
            transfer_call,
            raw_schema={
                "name": "transfer_call",
                "description": "Transfer the caller to a person.",
                "parameters": {"type": "object", "properties": {"target": {"type": "string"}}, "required": ["target"]},
            },
        )
    )
    return tools


async def run_scenario(
    config: AgentConfig,
    scenario: Scenario,
    *,
    agent_model: lk_llm.LLM,
    caller_model: lk_llm.LLM,
    judge_model: lk_llm.LLM,
    tools: list[ToolSpec] = (),  # type: ignore[assignment]
    extra_tools: list[Any] = (),  # type: ignore[assignment]
) -> ScenarioResult:
    """Play one scenario and judge it. Never raises: a failure is a result."""
    from .agent import VoiceAssistant  # the agent class a live call uses

    tokens = _Tokens()
    transcript: list[dict[str, str]] = []
    ended: dict[str, bool] = {}
    configured = config.with_variables(scenario.variables)

    async def play() -> int:
        agent = VoiceAssistant(
            configured.instructions, [*stub_tools(list(tools), scenario, ended), *extra_tools]
        )
        turns = 0
        async with AgentSession(llm=agent_model) as session:
            await session.start(agent)

            opener = await complete(
                caller_model,
                CALLER_SYSTEM,
                f"You are: {scenario.caller}\n\nThe call has just connected. What do you say first?",
                tokens,
            )
            caller_line = opener
            while turns < scenario.max_turns and caller_line and caller_line != END:
                transcript.append({"role": "caller", "text": caller_line})
                result = await session.run(user_input=caller_line)
                turns += 1
                for event in result.events:
                    if event.type == "message" and event.item.role == "assistant" and event.item.text_content:
                        transcript.append({"role": "agent", "text": event.item.text_content})
                    elif event.type == "function_call":
                        transcript.append({"role": "tool", "text": f"{event.item.name}({event.item.arguments})"})
                if ended:
                    break
                caller_line = await complete(
                    caller_model,
                    CALLER_SYSTEM,
                    f"You are: {scenario.caller}\n\nThe call so far:\n{_render(transcript)}\n\n"
                    "What do you say next?",
                    tokens,
                )
        return turns

    try:
        turns = await asyncio.wait_for(play(), SCENARIO_TIMEOUT_SECONDS)
    except Exception as exc:
        logger.exception("scenario %s failed to run", scenario.id)
        return ScenarioResult(scenario.id, False, transcript, [], len(transcript), str(exc)[:500], tokens.count)

    judgments = [await judge(judge_model, transcript, criterion, tokens) for criterion in scenario.criteria]
    passed = all(j["passed"] is True for j in judgments)
    return ScenarioResult(scenario.id, passed, transcript, judgments, turns, None, tokens.count)


async def judge(
    model: lk_llm.LLM, transcript: list[dict[str, str]], criterion: str, tokens: _Tokens
) -> dict[str, Any]:
    """Whether the transcript meets one criterion. Unclear counts as a fail."""
    try:
        raw = await complete(
            model,
            JUDGE_SYSTEM,
            f"Requirement: {criterion}\n\nTranscript:\n{_render(transcript)}",
            tokens,
        )
    except Exception as exc:
        return {"criterion": criterion, "passed": False, "reasoning": f"the judge failed: {exc}"}
    body = _extract_json(raw) or {}
    verdict = body.get("passed")
    return {
        "criterion": criterion,
        "passed": verdict is True,
        "reasoning": str(body.get("reasoning") or raw[:300]),
    }


async def run_all(
    config: AgentConfig,
    scenarios: list[Scenario],
    *,
    make_model: Callable[[], lk_llm.LLM],
    tools: list[ToolSpec] = (),  # type: ignore[assignment]
    extra_tools: list[Any] = (),  # type: ignore[assignment]
    report: Callable[[ScenarioResult], Awaitable[None]],
) -> list[ScenarioResult]:
    """Run scenarios one after another, reporting each as it finishes.

    One at a time rather than all at once, so a suite of twenty does not hit
    the model provider with sixty concurrent conversations.
    """
    results = []
    for scenario in scenarios:
        result = await run_scenario(
            config,
            scenario,
            agent_model=make_model(),
            caller_model=make_model(),
            judge_model=make_model(),
            tools=tools,
            extra_tools=extra_tools,
        )
        await report(result)
        results.append(result)
    return results


async def execute_run(control_plane: Any, run_id: str) -> None:
    """Fetch a test run from the control plane, play it, and report back.

    The one path both the `uv run evals` command and a dispatched worker job
    take, so a suite run from a laptop behaves as one run from the dashboard.
    """
    from livekit.plugins import sarvam

    from .control_plane import _resolved
    from .knowledge import knowledge_tool

    try:
        body = await control_plane.eval_run(run_id)
        agent = _resolved(body["agent"])
        config = AgentConfig.from_record(agent.as_record())
        scenarios = [Scenario.from_json(s) for s in body.get("scenarios") or []]

        extra: list[Any] = []
        if agent.has_knowledge:
            extra.append(
                knowledge_tool(
                    lambda query: control_plane.search_knowledge(agent.agent_version_id, agent.org_id, query)
                )
            )

        async def report(result: ScenarioResult) -> None:
            await control_plane.eval_result(run_id, result.as_payload())

        results = await run_all(
            config,
            scenarios,
            make_model=lambda: sarvam.LLM(model=config.llm_model),
            tools=list(agent.tools),
            extra_tools=extra,
            report=report,
        )
        await control_plane.finish_eval_run(
            run_id,
            {
                "status": "completed",
                "passed": sum(r.passed for r in results),
                "total": len(results),
                "tokens": sum(r.tokens for r in results),
            },
        )
    except Exception as exc:
        logger.exception("test run %s failed", run_id)
        await control_plane.finish_eval_run(run_id, {"status": "failed", "error": str(exc)[:500]})
