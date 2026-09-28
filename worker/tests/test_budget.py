"""Characterization tests for the per-call budget and the rate ceiling.

Both classes hold mutable state that today lives only in the entrypoint's
closure and is discarded when the job ends. The multi-tenant refactor gives that
state a durable home, so this pins down the behaviour that must survive: the
stage ratchet, the reserve that keeps a farewell affordable, and the guarantee
that nothing here raises mid-call.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from automitra_worker.budget import (
    HEAD_START_SECONDS,
    OPENING_OVERDRAFT_INR_PER_MIN,
    PLATFORM_MAX_INR_PER_MIN,
    CallBudget,
    RateCeiling,
    SentenceGate,
    Stage,
    effective_ceiling,
)


@dataclass
class FakeSummary:
    stt_audio_duration: float = 0.0
    tts_characters_count: int = 0
    llm_prompt_tokens: int = 0
    llm_prompt_cached_tokens: int = 0
    llm_completion_tokens: int = 0


MODELS = {
    "stt_model": "saaras:v4",
    "tts_model": "bulbul:v3",
    "llm_model": "sarvam-105b-conversations",
}


def budget(limit: float = 100.0, **kwargs: object) -> CallBudget:
    return CallBudget(limit_inr=limit, **MODELS, **kwargs)  # type: ignore[arg-type]


def spend(inr: float) -> FakeSummary:
    """A summary costing roughly ``inr``, charged entirely to TTS.

    TTS is Rs 0.003/char, so the character count is the cost divided by that.
    Using one component keeps the arithmetic of these tests obvious.

    The character count is whole, so the cost lands slightly *under* the figure
    asked for. Tests that need to cross a threshold should overshoot it rather
    than name it exactly.
    """
    return FakeSummary(tts_characters_count=int(inr / 0.003))


# --- enablement -------------------------------------------------------------


def test_zero_limit_disables_the_budget() -> None:
    b = budget(limit=0.0)
    assert not b.enabled
    assert b.update(spend(1_000.0)) is Stage.OK
    assert b.fraction_used == 0.0


# --- stage transitions ------------------------------------------------------


def test_stages_trip_in_order_as_spend_rises() -> None:
    b = budget(limit=100.0, warn_at=0.70, wrap_at=0.90)

    assert b.update(spend(10.0)) is Stage.OK
    assert b.update(spend(75.0)) is Stage.WARN
    assert b.update(spend(95.0)) is Stage.WRAP
    assert b.update(spend(105.0)) is Stage.HARD


def test_stage_never_moves_backwards() -> None:
    """Once told to wrap up, a cheaper later summary must not reopen the call."""
    b = budget(limit=100.0)
    b.update(spend(95.0))
    assert b.stage is Stage.WRAP

    # A summary reporting less usage than before (shouldn't happen, but the
    # ratchet is what makes it harmless).
    assert b.update(spend(1.0)) is Stage.WRAP
    assert b.stage is Stage.WRAP


def test_hard_stage_once_the_limit_is_exceeded() -> None:
    b = budget(limit=100.0)
    # ``spend`` truncates to a whole number of characters, so ask for slightly
    # over the limit rather than exactly it.
    assert b.update(spend(100.5)) is Stage.HARD


# --- the reserve ------------------------------------------------------------


def test_reserve_binds_before_the_wrap_fraction_on_a_small_budget() -> None:
    """The point of the reserve: leave enough to say goodbye.

    On a small budget, 90% of the limit may already be past the point where a
    farewell is still affordable, so the wrap stage trips on the reserve
    instead of the fraction.
    """
    b = budget(limit=2.0, wrap_at=0.90)
    reserve = b.reserve_inr
    assert reserve > 0

    # Spending past (limit - reserve) must wrap, even though it is under 90%.
    just_past_reserve = b.limit_inr - reserve + 0.01
    assert just_past_reserve < 0.90 * b.limit_inr

    assert b.update(spend(just_past_reserve)) is Stage.WRAP


def test_validate_rejects_a_budget_too_small_to_hold_a_conversation() -> None:
    b = budget(limit=0.01)
    with pytest.raises(ValueError, match="too small"):
        b.validate()


def test_validate_accepts_a_workable_budget() -> None:
    budget(limit=100.0).validate()  # must not raise


def test_validate_is_a_no_op_when_disabled() -> None:
    budget(limit=0.0).validate()  # must not raise


# --- derived figures --------------------------------------------------------


def test_remaining_never_goes_negative() -> None:
    b = budget(limit=10.0)
    b.update(spend(50.0))
    assert b.remaining_inr == 0.0


def test_implied_minutes_is_the_worst_case_duration() -> None:
    """The floor on call length: the agent talking non-stop.

    A real conversation, where the caller does half the talking, runs longer --
    so this is a lower bound, which is what makes it safe to quote.
    """
    b = budget(limit=10.0)
    # Rs 0.50/min STT + 900 chars/min * Rs 0.003 = Rs 3.20/min worst case.
    assert b.implied_minutes() == pytest.approx(10.0 / 3.2)


# --- resilience -------------------------------------------------------------


def test_unknown_model_does_not_raise_mid_call() -> None:
    """The live-call costing path must degrade, never crash.

    ``costs.actual_cost`` raises on an unpriced model because it is a reporting
    path. This one runs on every metrics event of a call already in progress,
    so it prices what it can and carries on.
    """
    b = CallBudget(
        limit_inr=100.0,
        stt_model="no-such-model",
        tts_model="no-such-model",
        llm_model="no-such-model",
    )
    assert b.update(spend(10.0)) is Stage.OK
    assert b.spent_inr == 0.0


# --- rate ceiling -----------------------------------------------------------


def ceiling(inr_per_min: float = 2.0) -> RateCeiling:
    return RateCeiling(ceiling_inr_per_min=inr_per_min, **MODELS)


class Clock:
    """Wall clock for a simulated call; sleeping advances it."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_effective_ceiling_never_exceeds_the_platform() -> None:
    assert effective_ceiling(0.0) == PLATFORM_MAX_INR_PER_MIN == 2.0
    assert effective_ceiling(5.0) == 2.0
    assert effective_ceiling(1.5) == 1.5


def test_ceiling_rejects_what_speech_to_text_alone_would_break() -> None:
    """STT alone costs Rs 0.50/min, so a ceiling at or below that is impossible."""
    with pytest.raises(ValueError, match="speech-to-text"):
        ceiling(0.50).validate()
    ceiling(2.0).validate()  # must not raise


def test_the_opening_line_fits_in_the_head_start() -> None:
    """Measured against the first second alone, any greeting is 'over the rate'."""
    c = ceiling()
    assert c.wait_for(150, elapsed_seconds=0.0) == 0.0


def test_speech_that_does_not_fit_yet_reports_how_long_to_wait() -> None:
    c = ceiling()
    # Rs 1.50/min is left over STT, so 30s of head start holds Rs 0.75.
    wait = c.wait_for(1000, elapsed_seconds=0.0)  # Rs 3 of speech
    assert wait > 60
    # And after that long it does fit.
    assert c.wait_for(1000, elapsed_seconds=wait + 0.01) == 0.0


def test_reserved_speech_is_counted_once_it_reaches_synthesis() -> None:
    c = ceiling()
    c.reserve(100)
    before = c.utilisation(60.0)
    c.count_tts(100)  # the same characters, now on their way in
    assert c.utilisation(60.0) == pytest.approx(before)


def test_a_new_reply_settles_what_an_interrupted_one_reserved() -> None:
    c = ceiling()
    c.reserve(500)
    c.begin_reply()
    assert c.utilisation(60.0) == 0.0


def test_measured_usage_counts_when_it_exceeds_what_was_seen() -> None:
    """Synthesis outside the pipeline (a cached greeting) still costs."""
    c = ceiling()
    c.observe(FakeSummary(tts_characters_count=300))
    assert c.utilisation(60.0) > 0


def test_steering_switches_on_near_the_ceiling_and_back_off_below_it() -> None:
    c = ceiling()
    # Rs 1.50 of the Rs 1.50 allowed over one minute: well past 80%.
    c.count_tts(450)
    assert c.steer(60.0) is True
    assert c.steer(60.0) is None  # no repeat while still high
    # Two minutes later the same spend is well under 60% of the allowance.
    assert c.steer(180.0) is False
    assert not c.tightened


def test_the_margin_grows_with_the_largest_request() -> None:
    c = ceiling()
    floor = c.llm_margin_inr
    c.observe_request(prompt_tokens=20_000, cached_tokens=0, completion_tokens=200)
    assert c.llm_margin_inr > floor


def test_gate_splits_on_sentence_ends_including_the_danda() -> None:
    gate = SentenceGate(ceiling(), Clock())
    assert gate.split("नमस्ते। आप कैसे") == ["नमस्ते। "]
    assert gate.split(" हैं? Fine.") == ["आप कैसे हैं? "]
    assert gate.rest() == ["Fine."]
    assert gate.rest() == []


def test_gate_breaks_up_text_that_never_ends_a_sentence() -> None:
    gate = SentenceGate(ceiling(), Clock())
    pieces = gate.split("word " * 100)
    assert pieces
    assert all(len(p) <= 201 for p in pieces)


async def test_gate_pauses_briefly_for_the_allowance_to_catch_up() -> None:
    clock = Clock()
    c = ceiling()
    gate = SentenceGate(c, clock, sleep=clock.sleep)
    # Fill the allowance up to 60s, then ask for a little more at 60s. The
    # opening sentence may overdraw, so it is the second one that waits.
    c.count_tts(int((1.5 - c.llm_margin_inr) / 0.003) - 10)
    clock.now = 60.0
    assert await gate.admit("x" * 5)
    assert clock.now == 60.0
    assert await gate.admit("x" * 20)
    assert 0 < clock.now - 60.0 <= 3.1


async def test_the_opening_sentence_may_overdraw_but_the_rest_may_not() -> None:
    clock = Clock()
    c = ceiling()
    gate = SentenceGate(c, clock, sleep=clock.sleep)
    # The plain allowance at 60s is used up entirely.
    c.count_tts(int((1.5 - c.llm_margin_inr) / 0.003))
    clock.now = 60.0
    assert await gate.may_request()
    assert await gate.admit("ठीक है, समझ गई। ")
    # Past the pause, the second sentence is dropped rather than overdrawn.
    assert not await gate.admit("x" * 200)
    assert gate.stopped


async def test_gate_ends_the_reply_rather_than_pausing_long() -> None:
    clock = Clock()
    c = ceiling()
    gate = SentenceGate(c, clock, sleep=clock.sleep)
    assert not await gate.admit("x" * 5000)
    assert gate.stopped
    # Everything after is dropped, even what would fit on its own.
    assert not await gate.admit("Short. ")
    assert gate.dropped_chars == 5007
    assert clock.now == 0.0


async def test_gate_skips_a_request_there_is_no_room_for() -> None:
    clock = Clock()
    c = ceiling()
    c.count_tts(1000)
    gate = SentenceGate(c, clock, sleep=clock.sleep)
    assert not await gate.may_request()


@pytest.mark.parametrize("ceiling_inr", [2.0, 1.5, 1.0])
@pytest.mark.parametrize("reply_chars", [80, 400, 2000])
async def test_cost_per_minute_never_exceeds_the_ceiling(
    ceiling_inr: float, reply_chars: int
) -> None:
    """The guarantee itself, on a simulated call with an agent that will not
    stop talking: whenever the caller hangs up, cost per minute is in bounds.
    The bound is the ceiling plus the overdraft opening sentences may use.

    Each turn the caller speaks for three seconds, the model is asked (and
    billed for a context that grows every turn), and the reply is offered to
    the gate sentence by sentence. What is admitted is billed at once and then
    takes real time to speak.
    """
    clock = Clock()
    c = ceiling(ceiling_inr)
    stt_rate, tts_rate = 0.5, 0.003
    llm_in, llm_out = 29.28, 73.2
    prompt_total = completion_total = 0
    tts_total = 0

    def spent() -> float:
        return (
            stt_rate * clock.now / 60
            + tts_rate * tts_total
            + (llm_in * prompt_total + llm_out * completion_total) / 1e6
        )

    def check() -> None:
        bound = ceiling_inr + OPENING_OVERDRAFT_INR_PER_MIN
        allowed = bound * max(clock.now, HEAD_START_SECONDS) / 60
        assert spent() <= allowed + 1e-9, (
            f"Rs {spent():.4f} spent by {clock.now:.1f}s; "
            f"only Rs {allowed:.4f} allowed"
        )

    sentence = ("यह एक वाक्य है जो बहुत लंबा है। ")
    for turn in range(60):
        clock.now += 3.0  # the caller speaks
        check()

        c.begin_reply()
        gate = SentenceGate(c, clock, sleep=clock.sleep)
        if not await gate.may_request():
            check()
            continue
        prompt = 1500 + 150 * turn
        prompt_total += prompt
        completion_total += 60
        c.observe_request(prompt, 0, 60)
        c.observe(
            FakeSummary(
                stt_audio_duration=clock.now,
                llm_prompt_tokens=prompt_total,
                llm_completion_tokens=completion_total,
            )
        )
        check()

        text = sentence * max(1, reply_chars // len(sentence))
        for piece in gate.split(text) + gate.rest():
            if not await gate.admit(piece):
                continue
            c.count_tts(len(piece))
            tts_total += len(piece)
            check()  # billed the moment it is sent
            clock.now += len(piece) / 15.0  # ~900 characters a minute
            check()

    assert clock.now > 180  # a long call, not a trivially short one
    assert tts_total > 0  # and the agent did get to speak


async def test_an_ordinary_conversation_is_never_met_with_silence() -> None:
    """Every turn of a normal call gets at least its first sentence spoken.

    Shaped on real calls with the KBS script: a greeting, then the caller
    speaks for three seconds, the model answers in a second with two short
    Hindi sentences, over a context that starts near 1,900 tokens and grows
    each turn. At list prices this runs a little over Rs 2/min, so the plain
    ceiling binds within a few turns; what it must not do is go quiet.
    """
    clock = Clock()
    c = ceiling()
    tts_total = 100  # the greeting
    c.count_tts(tts_total)
    clock.now = 100 / 15.0
    prompt_total = completion_total = 0
    reply = "ठीक है, समझ गई। जी, आपका नाम क्या है? "

    for turn in range(40):
        clock.now += 3.0 + 1.0  # the caller speaks; the model starts

        c.begin_reply()
        gate = SentenceGate(c, clock, sleep=clock.sleep)
        assert await gate.may_request(), f"turn {turn} skipped at {clock.now:.0f}s"
        prompt = 1900 + 80 * turn
        prompt_total += prompt
        completion_total += 25
        c.observe_request(prompt, 0, 25)
        c.observe(
            FakeSummary(
                stt_audio_duration=clock.now,
                llm_prompt_tokens=prompt_total,
                llm_completion_tokens=completion_total,
            )
        )

        spoken = 0
        for piece in gate.split(reply) + gate.rest():
            if not await gate.admit(piece):
                continue
            spoken += 1
            c.count_tts(len(piece))
            tts_total += len(piece)
            clock.now += len(piece) / 15.0
        assert spoken >= 1, f"turn {turn} was silent at {clock.now:.0f}s"

    assert clock.now > 180  # three minutes and more of conversation
