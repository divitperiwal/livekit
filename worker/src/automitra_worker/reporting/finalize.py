"""What the worker tells the API when a call ends."""

from automitra_worker.control_plane.contract import FinalizeCallRequest, LatencySummary, UsageReport
from automitra_worker.cost.call_budget import CallBudget, Stage
from automitra_worker.cost.usage_meter import UsageMeter
from automitra_worker.reporting.analysis import AnalysisResult
from automitra_worker.reporting.call_outcome import CallOutcome


def finalize_request(
    *,
    outcome: CallOutcome,
    budget: CallBudget,
    close_reason: str | None,
    duration_seconds: float,
    latency: LatencySummary | None,
    usage: UsageMeter,
    recording_key: str | None = None,
    analysis: AnalysisResult | None = None,
) -> FinalizeCallRequest:
    """Why it ended: the budget stage when the budget ended it ("the ceiling was reached"
    explains more than "the session closed"), else what the call itself decided, else
    the session's close reason."""
    end_reason = (
        budget.stage.name.lower()
        if budget.stage is not Stage.OK
        else outcome.end_reason or close_reason
    )
    return FinalizeCallRequest(
        status=outcome.status,
        end_reason=end_reason,
        duration_seconds=int(duration_seconds) if outcome.answered else 0,
        do_not_call=outcome.do_not_call,
        # Only ever a key whose upload succeeded; see CallRecorder.finish.
        recording_key=recording_key,
        latency=latency,
        analysis=analysis.analysis if analysis else None,
        # What was used, not what it cost: the API prices it, so a price change is one
        # API deploy. An unanswered call reports nothing a per-call minimum could bill.
        usage=_usage_report(usage, budget, analysis) if outcome.answered else None,
    )


def _usage_report(
    usage: UsageMeter, budget: CallBudget, analysis: AnalysisResult | None
) -> UsageReport:
    """The post-call analysis ran on the same model outside the session's meter; its
    tokens are part of what the call cost."""
    return UsageReport(
        stt_seconds=usage.stt_audio_duration,
        tts_characters=usage.tts_characters_count,
        llm_prompt_tokens=usage.llm_prompt_tokens + (analysis.prompt_tokens if analysis else 0),
        llm_cached_tokens=usage.llm_prompt_cached_tokens
        + (analysis.cached_tokens if analysis else 0),
        llm_completion_tokens=usage.llm_completion_tokens
        + (analysis.completion_tokens if analysis else 0),
        stt_model=budget.stt_model,
        tts_model=budget.tts_model,
        llm_model=budget.llm_model,
    )
