"""Characterization tests for the per-call budget and the rate guard.

Both classes hold mutable state that today lives only in the entrypoint's
closure and is discarded when the job ends. The multi-tenant refactor gives that
state a durable home, so this pins down the behaviour that must survive: the
stage ratchet, the reserve that keeps a farewell affordable, and the guarantee
that nothing here raises mid-call.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from automitra_worker.budget import CallBudget, RateGuard, Stage


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


# --- rate guard -------------------------------------------------------------


def test_rate_guard_disabled_at_zero() -> None:
    g = RateGuard(ceiling_inr_per_min=0.0, **MODELS)
    assert not g.enabled
    assert g.update(spend(100.0), 60.0) is False


def test_rate_guard_trips_once_and_latches() -> None:
    g = RateGuard(ceiling_inr_per_min=10.0, **MODELS)

    # Rs 20 in one minute, well over a Rs 10/min ceiling.
    assert g.update(spend(20.0), 60.0) is True
    assert g.tightened

    # Already tightened: further updates report no new transition.
    assert g.update(spend(40.0), 60.0) is False


def test_rate_guard_stays_quiet_under_the_ceiling() -> None:
    g = RateGuard(ceiling_inr_per_min=10.0, **MODELS)
    assert g.update(spend(1.0), 60.0) is False
    assert not g.tightened


def test_rate_guard_trips_below_the_ceiling_by_trip_at() -> None:
    """It trips at 90% -- by the time the rate reaches the ceiling the spend
    has already happened."""
    g = RateGuard(ceiling_inr_per_min=10.0, **MODELS)
    assert g.update(spend(9.5), 60.0) is True


def test_rate_guard_ignores_zero_elapsed_time() -> None:
    """Guards the division: metrics can arrive before the clock has moved."""
    g = RateGuard(ceiling_inr_per_min=10.0, **MODELS)
    assert g.update(spend(100.0), 0.0) is False


def test_rate_guard_rejects_a_ceiling_no_brevity_could_reach() -> None:
    """STT alone costs Rs 0.50/min, so a ceiling at or below that is impossible."""
    g = RateGuard(ceiling_inr_per_min=0.50, **MODELS)
    with pytest.raises(ValueError, match="speech-to-text"):
        g.validate()


def test_rate_guard_accepts_a_reachable_ceiling() -> None:
    RateGuard(ceiling_inr_per_min=5.0, **MODELS).validate()  # must not raise
