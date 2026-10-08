"""Guarantee 8: the per-call budget ends a call gracefully before the hard stop, even when
one turn is larger than the gap between the wrap and hard stages."""

import pytest
from cost_fakes import MODELS, FakeUsage

from automitra_worker.cost.call_budget import FAREWELL_CHARS, TYPICAL_TURN_CHARS, CallBudget, Stage

TTS_INR_PER_CHAR = 0.003
TURN_INR = TYPICAL_TURN_CHARS * TTS_INR_PER_CHAR


@pytest.mark.parametrize("limit_inr", [3.5, 5.0, 8.0, 20.0, 100.0])
@pytest.mark.parametrize("turn_chars", [50, 200, int(TYPICAL_TURN_CHARS)])
def test_wrap_comes_before_hard_with_the_farewell_still_affordable(limit_inr, turn_chars):
    budget = CallBudget(limit_inr=limit_inr, **MODELS)
    budget.validate()
    usage = FakeUsage()
    stages_seen: list[Stage] = []
    remaining_when_wrapped = None

    while budget.stage is not Stage.HARD:
        usage.tts_characters_count += turn_chars
        usage.stt_audio_duration += 4.0
        stage = budget.update(usage)
        if stage not in stages_seen:
            stages_seen.append(stage)
            if stage is Stage.WRAP:
                remaining_when_wrapped = budget.remaining_inr

    assert stages_seen.index(Stage.WRAP) < stages_seen.index(Stage.HARD)
    assert remaining_when_wrapped >= FAREWELL_CHARS * TTS_INR_PER_CHAR


def test_small_budgets_are_covered_where_one_turn_outruns_the_wrap_to_hard_gap():
    """The case the guarantee is about: on a Rs 5 budget the 10% gap is Rs 0.50, less
    than one Rs 1.20 turn, so the wrap fraction alone would jump straight to hard."""
    budget = CallBudget(limit_inr=5.0, **MODELS)
    gap_inr = (1 - budget.wrap_at) * budget.limit_inr
    assert TURN_INR > gap_inr

    under_wrap_fraction = 0.89 * budget.limit_inr
    stage = budget.update(
        FakeUsage(tts_characters_count=int(under_wrap_fraction / TTS_INR_PER_CHAR))
    )
    assert stage is Stage.WRAP
