import pytest
from cost_fakes import MODELS, Clock, FakeUsage

from automitra_worker.cost.rate_ceiling import RateCeiling
from automitra_worker.cost.sentence_gate import SentenceGate


def ceiling(inr_per_min: float = 2.0) -> RateCeiling:
    return RateCeiling(ceiling_inr_per_min=inr_per_min, **MODELS)


def fill_allowance_to_60_seconds(rate_ceiling: RateCeiling, leave_chars: int = 0) -> None:
    # At Rs 2/min, Rs 1.50/min is left over speech-to-text: Rs 1.50 by 60 s.
    rate_ceiling.count_tts(int((1.5 - rate_ceiling.llm_margin_inr) / 0.003) - leave_chars)


def test_a_ceiling_speech_to_text_alone_would_break_is_refused():
    with pytest.raises(ValueError, match="speech-to-text"):
        ceiling(0.50).validate()
    ceiling(2.0).validate()


def test_the_greeting_fits_in_the_head_start():
    assert ceiling().wait_for(150, elapsed_seconds=0.0) == 0.0


def test_speech_that_does_not_fit_yet_reports_how_long_to_wait():
    rate_ceiling = ceiling()
    wait = rate_ceiling.wait_for(1000, elapsed_seconds=0.0)  # Rs 3 of speech
    assert wait > 60
    assert rate_ceiling.wait_for(1000, elapsed_seconds=wait + 0.01) == 0.0


def test_admitted_speech_is_counted_once_when_it_reaches_synthesis():
    rate_ceiling = ceiling()
    rate_ceiling.reserve(100)
    before = rate_ceiling.utilisation(60.0)
    rate_ceiling.count_tts(100)
    assert rate_ceiling.utilisation(60.0) == pytest.approx(before)


def test_a_new_reply_settles_what_an_interrupted_one_admitted():
    rate_ceiling = ceiling()
    rate_ceiling.reserve(500)
    rate_ceiling.begin_reply()
    assert rate_ceiling.utilisation(60.0) == 0.0


def test_speech_synthesised_outside_the_pipeline_still_counts():
    rate_ceiling = ceiling()
    rate_ceiling.observe(FakeUsage(tts_characters_count=300))
    assert rate_ceiling.utilisation(60.0) > 0


def test_steering_switches_on_near_the_ceiling_and_off_well_below_it():
    rate_ceiling = ceiling()
    rate_ceiling.count_tts(450)
    assert rate_ceiling.steer(60.0) is True
    assert rate_ceiling.steer(60.0) is None
    assert rate_ceiling.steer(180.0) is False
    assert not rate_ceiling.tightened


def test_the_room_kept_for_the_next_request_grows_with_the_largest_request():
    rate_ceiling = ceiling()
    floor = rate_ceiling.llm_margin_inr
    rate_ceiling.observe_request(prompt_tokens=20_000, cached_tokens=0, completion_tokens=200)
    assert rate_ceiling.llm_margin_inr > floor


def test_the_gate_splits_on_sentence_ends_including_the_danda():
    gate = SentenceGate(ceiling(), Clock())
    assert gate.split("नमस्ते। आप कैसे") == ["नमस्ते। "]
    assert gate.split(" हैं? Fine.") == ["आप कैसे हैं? "]
    assert gate.rest() == ["Fine."]
    assert gate.rest() == []


def test_the_gate_breaks_up_text_that_never_ends_a_sentence():
    pieces = SentenceGate(ceiling(), Clock()).split("word " * 100)
    assert pieces and all(len(piece) <= 201 for piece in pieces)


async def test_the_gate_pauses_briefly_for_the_allowance_to_catch_up():
    clock, rate_ceiling = Clock(), ceiling()
    gate = SentenceGate(rate_ceiling, clock, sleep=clock.sleep)
    fill_allowance_to_60_seconds(rate_ceiling, leave_chars=10)
    clock.now = 60.0
    assert await gate.admit("x" * 5)  # the opening sentence may overdraw
    assert clock.now == 60.0
    assert await gate.admit("x" * 20)
    assert 0 < clock.now - 60.0 <= 3.1


async def test_only_the_opening_sentence_may_overdraw():
    clock, rate_ceiling = Clock(), ceiling()
    gate = SentenceGate(rate_ceiling, clock, sleep=clock.sleep)
    fill_allowance_to_60_seconds(rate_ceiling)
    clock.now = 60.0
    assert await gate.may_request()
    assert await gate.admit("ठीक है, समझ गई। ")
    assert not await gate.admit("x" * 200)
    assert gate.stopped


async def test_the_gate_ends_the_reply_rather_than_pausing_long():
    clock, rate_ceiling = Clock(), ceiling()
    gate = SentenceGate(rate_ceiling, clock, sleep=clock.sleep)
    assert not await gate.admit("x" * 5000)
    assert not await gate.admit("Short. ")
    assert gate.dropped_chars == 5007
    assert clock.now == 0.0


async def test_the_gate_skips_a_request_there_is_no_room_for():
    clock, rate_ceiling = Clock(), ceiling()
    rate_ceiling.count_tts(1000)
    assert not await SentenceGate(rate_ceiling, clock, sleep=clock.sleep).may_request()
