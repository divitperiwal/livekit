from types import SimpleNamespace

import pytest
from cost_fakes import MODELS, llm_metric, tts_metric
from livekit.agents import metrics

from automitra_worker.call import call_limit_inr
from automitra_worker.cost.call_budget import CallBudget, Stage
from automitra_worker.cost.usage_meter import UsageMeter
from automitra_worker.reporting import call_events
from automitra_worker.reporting.call_outcome import CallOutcome
from automitra_worker.reporting.finalize import finalize_request
from automitra_worker.reporting.latency import LatencyTracker, percentile


def item(role="user", text_content="नमस्ते", **extra):
    return SimpleNamespace(role=role, text_content=text_content, id="item-1", **extra)


def test_finished_turns_become_rows_by_role():
    assert call_events.conversation_item(item())["type"] == "user_message"
    assert call_events.conversation_item(item(role="assistant"))["type"] == "agent_message"
    assert call_events.conversation_item(item(role="system")) is None
    assert call_events.conversation_item(item(text_content="   ")) is None


def test_non_text_parts_are_dropped_and_interruptions_kept():
    row = call_events.conversation_item(
        SimpleNamespace(
            role="assistant", text_content=None, content=["जी", object(), "बताइए"], interrupted=True
        )
    )
    assert row["content"] == "जी बताइए" and row["payload"]["interrupted"] is True


def test_a_runaway_turn_is_truncated():
    row = call_events.conversation_item(item(text_content="x" * 20_000))
    assert row["content"].endswith("[truncated]") and len(row["content"]) < 16_100


def test_errors_stages_and_close_reasons_are_recorded():
    error = call_events.error_event(RuntimeError("x" * 2000), SimpleNamespace())
    assert len(error["content"]) == 1000 and error["payload"]["source"] == "SimpleNamespace"
    assert call_events.stage_event("WRAP", 9.1234567, 10.0)["payload"] == {
        "spentInr": 9.1235,
        "limitInr": 10.0,
    }
    assert (
        call_events.close_reason(SimpleNamespace(reason=SimpleNamespace(value="user_initiated")))
        == "user_initiated"
    )
    assert call_events.close_reason(SimpleNamespace(reason="error")) == "error"
    assert call_events.close_reason(object()) == "unknown"


def eou_metric(speech_id: str, delay: float) -> metrics.EOUMetrics:
    return metrics.EOUMetrics(
        timestamp=0.0,
        end_of_utterance_delay=delay,
        transcription_delay=0.1,
        on_user_turn_completed_delay=0.0,
        speech_id=speech_id,
    )


def test_latency_joins_the_three_waits_per_reply_and_names_the_dominant_one():
    tracker = LatencyTracker()
    for speech_id, (eou, llm, tts) in {"a": (0.5, 0.9, 0.3), "b": (0.4, 1.4, 0.2)}.items():
        tracker.collect(eou_metric(speech_id, eou))
        tracker.collect(
            llm_metric(1000, 20).model_copy(update={"ttft": llm, "speech_id": speech_id})
        )
        tracker.collect(tts_metric(80).model_copy(update={"ttfb": tts, "speech_id": speech_id}))
    tracker.collect(tts_metric(80).model_copy(update={"ttfb": 0.3, "speech_id": "greeting"}))
    summary = tracker.summary()
    assert summary.turns == 2
    assert summary.max == pytest.approx(2.0)
    assert summary.dominant == "llm"


def test_no_complete_turn_means_no_latency_summary():
    assert LatencyTracker().summary() is None
    assert percentile([], 0.5) == 0.0
    assert percentile([3.0, 1.0, 2.0], 0.5) == 2.0


def budget(stage: Stage = Stage.OK) -> CallBudget:
    call_budget = CallBudget(limit_inr=10.0, **MODELS)
    call_budget.stage = stage
    return call_budget


def test_the_end_reason_prefers_the_budget_then_the_call_then_the_session():
    usage = UsageMeter(stt_audio_duration=60.0, tts_characters_count=300)
    by_budget = finalize_request(
        outcome=CallOutcome(end_reason="transfer"),
        budget=budget(Stage.WRAP),
        close_reason="user_initiated",
        duration_seconds=61.7,
        latency=None,
        usage=usage,
    )
    by_call = finalize_request(
        outcome=CallOutcome(end_reason="transfer"),
        budget=budget(),
        close_reason="user_initiated",
        duration_seconds=61.7,
        latency=None,
        usage=usage,
    )
    by_session = finalize_request(
        outcome=CallOutcome(),
        budget=budget(),
        close_reason="user_initiated",
        duration_seconds=61.7,
        latency=None,
        usage=usage,
    )
    assert (by_budget.end_reason, by_call.end_reason, by_session.end_reason) == (
        "wrap",
        "transfer",
        "user_initiated",
    )
    assert by_session.duration_seconds == 61
    assert by_session.usage.stt_seconds == 60.0 and by_session.usage.tts_model == "bulbul:v3"


def test_an_unanswered_call_reports_no_usage_or_duration():
    request = finalize_request(
        outcome=CallOutcome(status="no_answer", answered=False),
        budget=budget(),
        close_reason=None,
        duration_seconds=30,
        latency=None,
        usage=UsageMeter(stt_audio_duration=5),
    )
    assert request.usage is None and request.duration_seconds == 0


@pytest.mark.parametrize(
    ("configured", "available", "limit"),
    [
        (20.0, None, 20.0),
        (0.0, None, 0.0),
        (0.0, 150.0, 150.0),
        (20.0, 150.0, 20.0),
        (200.0, 150.0, 150.0),
    ],
)
def test_the_call_budget_is_capped_to_what_the_account_can_spend(configured, available, limit):
    assert call_limit_inr(configured, available) == limit
