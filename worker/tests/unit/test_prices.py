"""Expected figures are written out longhand, not derived from the rate tables: a test that
reads the same table as the code would pass even if the table were wrong."""

import pytest
from cost_fakes import MODELS, FakeUsage, llm_metric, stt_metric, tts_metric

from automitra_worker.cost.estimate import CallProfile, estimate
from automitra_worker.cost.prices import check_priced, usage_cost
from automitra_worker.cost.usage_meter import UsageMeter


def test_nothing_used_costs_nothing():
    assert usage_cost(FakeUsage(), **MODELS).total_inr == 0.0


def test_speech_to_text_is_priced_per_minute_of_audio():
    assert usage_cost(FakeUsage(stt_audio_duration=120.0), **MODELS).stt_inr == pytest.approx(1.0)


def test_text_to_speech_is_priced_per_character():
    assert usage_cost(FakeUsage(tts_characters_count=10_000), **MODELS).tts_inr == pytest.approx(
        30.0
    )


def test_llm_input_and_output_are_priced_separately():
    usage = FakeUsage(llm_prompt_tokens=1_000_000, llm_completion_tokens=1_000_000)
    assert usage_cost(usage, **MODELS).llm_inr == pytest.approx(29.28 + 73.2)


def test_cached_tokens_are_part_of_the_prompt_not_extra():
    usage = FakeUsage(llm_prompt_tokens=1_000_000, llm_prompt_cached_tokens=1_000_000)
    assert usage_cost(usage, **MODELS).llm_inr == pytest.approx(10.98)
    partly = FakeUsage(llm_prompt_tokens=1_000_000, llm_prompt_cached_tokens=250_000)
    assert usage_cost(partly, **MODELS).llm_inr == pytest.approx(0.75 * 29.28 + 0.25 * 10.98)


def test_more_cached_than_prompt_tokens_is_not_a_credit():
    usage = FakeUsage(llm_prompt_tokens=1_000, llm_prompt_cached_tokens=5_000)
    assert usage_cost(usage, **MODELS).llm_inr == pytest.approx(1_000 * 10.98 / 1e6)


def test_an_unpriced_model_costs_nothing_live_but_is_loud_when_checked():
    unpriced = {
        "stt_model": "no-such-model",
        "tts_model": "bulbul:v3",
        "llm_model": "sarvam-105b-conversations",
    }
    assert usage_cost(FakeUsage(stt_audio_duration=60.0), **unpriced).stt_inr == 0.0
    with pytest.raises(KeyError, match="no-such-model"):
        check_priced(**unpriced)


def test_every_model_the_config_allows_has_a_price():
    from automitra_worker.agent_config.sarvam_catalog import LLM_MODELS, STT_MODELS, TTS_MODELS

    for stt_model in STT_MODELS:
        for tts_model in TTS_MODELS:
            for llm_model in LLM_MODELS:
                check_priced(stt_model=stt_model, tts_model=tts_model, llm_model=llm_model)


def test_the_estimate_assumes_no_cache_so_it_errs_high():
    per_minute = estimate(**MODELS)
    profile = CallProfile()
    cached_minute = usage_cost(
        FakeUsage(
            stt_audio_duration=60.0,
            tts_characters_count=int(profile.tts_chars_per_min),
            llm_prompt_tokens=int(profile.llm_input_tokens_per_min),
            llm_prompt_cached_tokens=int(profile.llm_input_tokens_per_min * 0.9),
            llm_completion_tokens=int(profile.llm_output_tokens_per_min),
        ),
        **MODELS,
    )
    assert cached_minute.total_inr < per_minute.total_inr


def test_how_much_the_agent_talks_moves_the_estimate():
    quiet = estimate(**MODELS, profile=CallProfile(agent_speaking_fraction=0.25))
    chatty = estimate(**MODELS, profile=CallProfile(agent_speaking_fraction=0.75))
    assert chatty.total_inr > quiet.total_inr
    assert chatty.stt_inr == pytest.approx(quiet.stt_inr)


def test_the_meter_adds_up_each_kind_of_metric():
    meter = UsageMeter()
    for metric in (
        stt_metric(2.5),
        stt_metric(1.5),
        tts_metric(120),
        llm_metric(2000, 40, cached_tokens=500),
    ):
        meter.collect(metric)
    meter.collect(object())
    assert (meter.stt_audio_duration, meter.tts_characters_count) == (4.0, 120)
    assert (
        meter.llm_prompt_tokens,
        meter.llm_prompt_cached_tokens,
        meter.llm_completion_tokens,
    ) == (2000, 500, 40)
