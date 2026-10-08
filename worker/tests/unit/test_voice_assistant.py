"""Steering must not disturb the prompt prefix Sarvam's server has cached."""

from typing import Any

import pytest
from livekit.agents import Agent, llm

from automitra_worker.pipeline.voice_assistant import VoiceAssistant


@pytest.fixture
def requests_sent(monkeypatch) -> list[llm.ChatContext]:
    sent: list[llm.ChatContext] = []

    async def fake_llm_node(agent: Any, chat_ctx: llm.ChatContext, tools: Any, settings: Any):
        sent.append(chat_ctx)
        yield "ok"

    monkeypatch.setattr(Agent.default, "llm_node", staticmethod(fake_llm_node))
    return sent


def conversation() -> llm.ChatContext:
    chat_ctx = llm.ChatContext()
    chat_ctx.add_message(role="system", content=["You are a showroom assistant."])
    chat_ctx.add_message(role="user", content=["Thar ki price?"])
    return chat_ctx


async def reply(agent: VoiceAssistant, chat_ctx: llm.ChatContext) -> list[Any]:
    return [chunk async for chunk in agent.llm_node(chat_ctx, [], None)]


async def test_steering_goes_last_and_leaves_the_cached_prefix_alone(requests_sent):
    agent = VoiceAssistant("You are a showroom assistant.")
    chat_ctx = conversation()
    await reply(agent, chat_ctx)
    agent.steering = "Be brief."
    await reply(agent, chat_ctx)

    plain, steered = requests_sent
    plain_texts = [message.text_content for message in plain.messages()]
    assert [message.text_content for message in steered.messages()][
        : len(plain_texts)
    ] == plain_texts
    last = steered.messages()[-1]
    assert (last.role, last.text_content) == ("system", "Be brief.")


async def test_steering_never_enters_the_conversation(requests_sent):
    agent = VoiceAssistant("You are a showroom assistant.")
    agent.steering = "Be brief."
    chat_ctx = conversation()
    await reply(agent, chat_ctx)
    assert len(chat_ctx.messages()) == 2


async def test_without_steering_the_context_is_sent_untouched(requests_sent):
    chat_ctx = conversation()
    await reply(VoiceAssistant("You are a showroom assistant."), chat_ctx)
    assert requests_sent[0] is chat_ctx
