import pytest
from cost_fakes import MODELS, tts_spend

from automitra_worker.cost.call_budget import CallBudget, Stage


def budget(limit: float = 100.0, **options) -> CallBudget:
    return CallBudget(limit_inr=limit, **MODELS, **options)


def test_a_zero_limit_switches_the_budget_off():
    off = budget(limit=0.0)
    assert not off.enabled
    assert off.update(tts_spend(1_000.0)) is Stage.OK
    assert off.fraction_used == 0.0


def test_stages_trip_in_order_as_spend_rises():
    call = budget(limit=100.0, warn_at=0.70, wrap_at=0.90)
    assert call.update(tts_spend(10.0)) is Stage.OK
    assert call.update(tts_spend(75.0)) is Stage.WARN
    assert call.update(tts_spend(95.0)) is Stage.WRAP
    assert call.update(tts_spend(100.5)) is Stage.HARD


def test_the_stage_never_moves_backwards():
    call = budget(limit=100.0)
    call.update(tts_spend(95.0))
    assert call.update(tts_spend(1.0)) is Stage.WRAP


def test_on_a_small_budget_the_reserve_binds_before_the_wrap_fraction():
    call = budget(limit=4.0, wrap_at=0.90)
    just_past_reserve = call.limit_inr - call.reserve_inr + 0.01
    assert just_past_reserve < 0.90 * call.limit_inr
    assert call.update(tts_spend(just_past_reserve)) is Stage.WRAP


def test_a_budget_too_small_for_a_conversation_is_refused_before_answering():
    with pytest.raises(ValueError, match="too small"):
        budget(limit=0.01).validate()
    budget(limit=100.0).validate()
    budget(limit=0.0).validate()


def test_remaining_never_goes_negative():
    call = budget(limit=10.0)
    call.update(tts_spend(50.0))
    assert call.remaining_inr == 0.0


def test_implied_minutes_is_the_worst_case_duration():
    # Rs 0.50/min speech-to-text + 900 characters/min x Rs 0.003 = Rs 3.20/min.
    assert budget(limit=10.0).implied_minutes() == pytest.approx(10.0 / 3.2)


def test_an_unpriced_model_does_not_raise_mid_call():
    call = CallBudget(limit_inr=100.0, stt_model="x", tts_model="x", llm_model="x")
    assert call.update(tts_spend(10.0)) is Stage.OK
    assert call.spent_inr == 0.0
