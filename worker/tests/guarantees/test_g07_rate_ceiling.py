"""Guarantee 7: at every moment of a call, Sarvam spend <= rate ceiling x max(elapsed, 30 s),
plus the Rs 0.50/min opening overdraft. Text over the ceiling is never synthesised and
never appears in the transcript."""

from typing import Any

import pytest
from cost_fakes import MODELS, Clock, FakeUsage
from livekit.agents import Agent

from automitra_worker.cost.rate_ceiling import (
    HEAD_START_SECONDS,
    OPENING_OVERDRAFT_INR_PER_MIN,
    RateCeiling,
)
from automitra_worker.cost.sentence_gate import SentenceGate
from automitra_worker.pipeline.voice_assistant import VoiceAssistant

STT_INR_PER_MIN, TTS_INR_PER_CHAR, LLM_INPUT_PER_MTOK, LLM_OUTPUT_PER_MTOK = 0.5, 0.003, 29.28, 73.2
HINDI_SENTENCE = "यह एक वाक्य है जो बहुत लंबा है। "


@pytest.mark.parametrize("ceiling_inr", [2.0, 1.5, 1.0])
@pytest.mark.parametrize("reply_chars", [80, 400, 2000])
async def test_spend_never_exceeds_the_ceiling_at_any_moment(ceiling_inr, reply_chars):
    """An agent that will not stop talking, over a long call with a growing context.
    What is admitted is billed the moment it is sent, then takes real time to speak."""
    clock = Clock()
    rate_ceiling = RateCeiling(ceiling_inr_per_min=ceiling_inr, **MODELS)
    prompt_total = completion_total = tts_total = 0

    def assert_within_ceiling() -> None:
        spent = (
            STT_INR_PER_MIN * clock.now / 60
            + TTS_INR_PER_CHAR * tts_total
            + (LLM_INPUT_PER_MTOK * prompt_total + LLM_OUTPUT_PER_MTOK * completion_total) / 1e6
        )
        allowed = (
            (ceiling_inr + OPENING_OVERDRAFT_INR_PER_MIN) * max(clock.now, HEAD_START_SECONDS) / 60
        )
        assert spent <= allowed + 1e-9, (
            f"Rs {spent:.4f} spent by {clock.now:.1f}s; Rs {allowed:.4f} allowed"
        )

    for turn in range(60):
        clock.now += 3.0  # the caller speaks
        assert_within_ceiling()

        rate_ceiling.begin_reply()
        gate = SentenceGate(rate_ceiling, clock, sleep=clock.sleep)
        if not await gate.may_request():
            assert_within_ceiling()
            continue
        prompt = 1500 + 150 * turn
        prompt_total += prompt
        completion_total += 60
        rate_ceiling.observe_request(prompt, 0, 60)
        rate_ceiling.observe(
            FakeUsage(
                stt_audio_duration=clock.now,
                llm_prompt_tokens=prompt_total,
                llm_completion_tokens=completion_total,
            )
        )
        assert_within_ceiling()

        reply = HINDI_SENTENCE * max(1, reply_chars // len(HINDI_SENTENCE))
        for piece in gate.split(reply) + gate.rest():
            if not await gate.admit(piece):
                continue
            rate_ceiling.count_tts(len(piece))
            tts_total += len(piece)
            assert_within_ceiling()
            clock.now += len(piece) / 15.0  # ~900 characters a minute
            assert_within_ceiling()

    assert clock.now > 180 and tts_total > 0


async def test_an_ordinary_conversation_is_never_met_with_silence():
    """Shaped on real KBS calls: about Rs 2/min at list prices, so the plain ceiling binds
    within a few turns. Every turn must still get its first sentence spoken."""
    clock, rate_ceiling = Clock(), RateCeiling(ceiling_inr_per_min=2.0, **MODELS)
    rate_ceiling.count_tts(100)  # the greeting
    clock.now = 100 / 15.0
    prompt_total = completion_total = 0
    reply = "ठीक है, समझ गई। जी, आपका नाम क्या है? "

    for turn in range(40):
        clock.now += 4.0
        rate_ceiling.begin_reply()
        gate = SentenceGate(rate_ceiling, clock, sleep=clock.sleep)
        assert await gate.may_request(), f"turn {turn} skipped at {clock.now:.0f}s"
        prompt = 1900 + 80 * turn
        prompt_total += prompt
        completion_total += 25
        rate_ceiling.observe_request(prompt, 0, 25)
        rate_ceiling.observe(
            FakeUsage(
                stt_audio_duration=clock.now,
                llm_prompt_tokens=prompt_total,
                llm_completion_tokens=completion_total,
            )
        )
        spoken = 0
        for piece in gate.split(reply) + gate.rest():
            if await gate.admit(piece):
                spoken += 1
                rate_ceiling.count_tts(len(piece))
                clock.now += len(piece) / 15.0
        assert spoken >= 1, f"turn {turn} was silent at {clock.now:.0f}s"

    assert clock.now > 180


async def test_text_over_the_ceiling_never_leaves_the_model_node(monkeypatch):
    """Whatever the model node yields is what is synthesised and what the transcript and
    chat history record. Text the gate drops is never yielded, so it is none of those."""
    opening = "जी, बताइए। "
    over_the_ceiling = "x" * 190 + ". "

    async def model_that_will_not_stop(agent: Any, chat_ctx: Any, tools: Any, settings: Any):
        yield opening
        yield over_the_ceiling
        yield "Short. "

    monkeypatch.setattr(Agent.default, "llm_node", staticmethod(model_that_will_not_stop))
    rate_ceiling = RateCeiling(ceiling_inr_per_min=2.0, **MODELS)
    # The plain allowance at 60 s is used up; only the opening overdraft is left.
    rate_ceiling.count_tts(int((1.5 - rate_ceiling.llm_margin_inr) / 0.003))
    assistant = VoiceAssistant("prompt", ceiling=rate_ceiling, elapsed=lambda: 60.0)

    yielded = [chunk async for chunk in assistant.llm_node(None, [], None)]

    assert yielded == [opening]
