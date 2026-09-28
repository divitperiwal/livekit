"""Mid-call steering must not disturb the prompt the model server has cached.

Sarvam's model server reuses the longest prefix a request shares with earlier
ones. The system prompt comes first, so rewriting it mid-call -- as steering
the agent to be brief once did -- throws away the cached conversation on every
change. Steering is added at the end of each request instead.
"""

from __future__ import annotations

from typing import Any

import pytest
from livekit.agents import Agent, llm

from automitra_worker.agent import VoiceAssistant


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[llm.ChatContext]:
    """The contexts the model is asked with, in place of a real request."""
    requests: list[llm.ChatContext] = []

    async def fake(agent: Any, chat_ctx: llm.ChatContext, tools: Any, settings: Any):
        requests.append(chat_ctx)
        yield "ok"

    monkeypatch.setattr(Agent.default, "llm_node", staticmethod(fake))
    return requests


def conversation() -> llm.ChatContext:
    ctx = llm.ChatContext()
    ctx.add_message(role="system", content=["You are a showroom assistant."])
    ctx.add_message(role="user", content=["Thar ki price?"])
    return ctx


async def reply(agent: VoiceAssistant, ctx: llm.ChatContext) -> None:
    async for _ in agent.llm_node(ctx, [], None):  # type: ignore[arg-type]
        pass


async def test_steering_goes_last_and_leaves_the_prefix_alone(sent: list[llm.ChatContext]) -> None:
    agent = VoiceAssistant("You are a showroom assistant.")
    ctx = conversation()

    await reply(agent, ctx)
    agent.steering = "Be brief."
    await reply(agent, ctx)

    plain, steered = sent
    # Everything the first request sent is an unchanged prefix of the second.
    assert [m.text_content for m in steered.messages()][: len(plain.messages())] == [
        m.text_content for m in plain.messages()
    ]
    last = steered.messages()[-1]
    assert (last.role, last.text_content) == ("system", "Be brief.")


async def test_steering_does_not_enter_the_conversation(sent: list[llm.ChatContext]) -> None:
    agent = VoiceAssistant("You are a showroom assistant.")
    agent.steering = "Be brief."
    ctx = conversation()
    await reply(agent, ctx)
    assert len(ctx.messages()) == 2


async def test_no_steering_sends_the_context_untouched(sent: list[llm.ChatContext]) -> None:
    agent = VoiceAssistant("You are a showroom assistant.")
    ctx = conversation()
    await reply(agent, ctx)
    assert sent[0] is ctx
