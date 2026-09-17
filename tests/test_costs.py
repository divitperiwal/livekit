"""Characterization tests for cost calculation.

These pin down what the current code computes, so the multi-tenant refactor --
which moves rates out of module globals and into per-tenant rate cards -- can be
checked against behaviour rather than against a reading of the diff.

The arithmetic here is written out longhand rather than expressed in terms of
the rate constants. Deriving the expected value from the same table the code
reads would pass even if that table were wrong; these numbers are independent.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from livekit_python.costs import CallProfile, actual_cost, estimate


@dataclass
class FakeSummary:
    """Stands in for a livekit ``UsageSummary``.

    ``actual_cost`` reads its fields with ``getattr``, so a plain object with
    the right attribute names is all it needs. This keeps the tests free of the
    agents runtime.
    """

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


def test_empty_summary_costs_nothing() -> None:
    cost = actual_cost(FakeSummary(), **MODELS)
    assert cost.total_inr == 0.0


def test_stt_is_priced_per_minute_of_audio() -> None:
    # saaras:v4 is Rs 30/hour = Rs 0.50/min. Two minutes of audio.
    cost = actual_cost(FakeSummary(stt_audio_duration=120.0), **MODELS)
    assert cost.stt_inr == pytest.approx(1.0)
    assert cost.total_inr == pytest.approx(1.0)


def test_tts_is_priced_per_character() -> None:
    # bulbul:v3 is Rs 30 per 10,000 characters = Rs 0.003/char.
    cost = actual_cost(FakeSummary(tts_characters_count=10_000), **MODELS)
    assert cost.tts_inr == pytest.approx(30.0)


def test_llm_input_and_output_are_priced_separately() -> None:
    # Rs 29.28 per million input, Rs 73.20 per million output.
    cost = actual_cost(
        FakeSummary(llm_prompt_tokens=1_000_000, llm_completion_tokens=1_000_000),
        **MODELS,
    )
    assert cost.llm_inr == pytest.approx(29.28 + 73.2)


def test_cached_tokens_are_a_subset_of_prompt_tokens_not_an_addition() -> None:
    """The subtraction that is easy to lose in a refactor.

    Cached tokens are reported *within* the prompt total, not alongside it. If
    the fresh count were not reduced by the cached count, this call would be
    billed for two million input tokens instead of one, and every long call
    would be overcharged.
    """
    summary = FakeSummary(
        llm_prompt_tokens=1_000_000,
        llm_prompt_cached_tokens=1_000_000,
    )
    cost = actual_cost(summary, **MODELS)

    # Wholly cached: Rs 10.98/Mtok, not Rs 29.28, and definitely not both.
    assert cost.llm_inr == pytest.approx(10.98)


def test_partially_cached_prompt_splits_across_both_rates() -> None:
    summary = FakeSummary(
        llm_prompt_tokens=1_000_000,
        llm_prompt_cached_tokens=250_000,
    )
    cost = actual_cost(summary, **MODELS)

    expected = 0.75 * 29.28 + 0.25 * 10.98
    assert cost.llm_inr == pytest.approx(expected)


def test_cached_exceeding_prompt_does_not_go_negative() -> None:
    """Defensive: a provider reporting oddly must not produce a credit."""
    summary = FakeSummary(
        llm_prompt_tokens=1_000,
        llm_prompt_cached_tokens=5_000,
    )
    cost = actual_cost(summary, **MODELS)
    assert cost.llm_inr >= 0.0


def test_components_sum_to_total() -> None:
    summary = FakeSummary(
        stt_audio_duration=60.0,
        tts_characters_count=5_000,
        llm_prompt_tokens=100_000,
        llm_prompt_cached_tokens=20_000,
        llm_completion_tokens=8_000,
    )
    cost = actual_cost(summary, **MODELS)
    assert cost.total_inr == pytest.approx(
        cost.stt_inr + cost.tts_inr + cost.llm_inr
    )


def test_unknown_model_raises() -> None:
    """``actual_cost`` is a reporting path, so an unpriced model must be loud.

    This is deliberately the opposite of ``budget._cost_so_far``, which runs
    mid-call and must never raise.
    """
    with pytest.raises(KeyError):
        actual_cost(FakeSummary(), stt_model="no-such-model",
                    tts_model="bulbul:v3", llm_model="sarvam-105b-conversations")


def test_estimate_assumes_no_cache_and_so_exceeds_a_cached_call() -> None:
    """The estimate errs high: it is a budgeting figure, not a prediction."""
    per_min = estimate(**MODELS, profile=CallProfile())

    # One minute of the same shape, but with most of the prompt cached.
    profile = CallProfile()
    actual = actual_cost(
        FakeSummary(
            stt_audio_duration=60.0,
            tts_characters_count=profile.tts_chars_per_min,
            llm_prompt_tokens=int(profile.llm_input_tokens_per_min),
            llm_prompt_cached_tokens=int(profile.llm_input_tokens_per_min * 0.9),
            llm_completion_tokens=int(profile.llm_output_tokens_per_min),
        ),
        **MODELS,
    )
    assert actual.total_inr < per_min.total_inr


def test_estimate_scales_with_agent_talkativeness() -> None:
    """TTS is the largest line item, so the agent's share of the talking moves it."""
    quiet = estimate(**MODELS, profile=CallProfile(agent_speaking_fraction=0.25))
    chatty = estimate(**MODELS, profile=CallProfile(agent_speaking_fraction=0.75))
    assert chatty.total_inr > quiet.total_inr
    assert chatty.stt_inr == pytest.approx(quiet.stt_inr)  # STT is fixed per minute
