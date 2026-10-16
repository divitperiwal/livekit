import logging
import time

import pytest
from livekit.agents import APIConnectionError, APIStatusError
from livekit.agents.llm import LLMError
from livekit.agents.stt import STTError
from livekit.agents.tts import TTSError

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.pipeline.rate_limit_alert import is_rate_limited
from automitra_worker.pipeline.session import build_analysis_llm, build_llm, build_stt, build_tts

ALERT = "ALERT sarvam-rate-limited"
WITH_FALLBACKS = AgentConfigModel(
    fallback_stt="deepgram/nova-3",
    fallback_llm="openai/gpt-4.1-mini",
    fallback_tts="cartesia/sonic-3",
)


@pytest.fixture(autouse=True)
def credentials(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("LIVEKIT_API_KEY", "test-key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "test-secret-of-at-least-32-bytes")


def emit_error(service, error_type, error: Exception) -> None:
    service.emit(
        "error",
        error_type(timestamp=time.time(), label=service.label, error=error, recoverable=True),
    )


def alerts(caplog) -> list[str]:
    return [record.getMessage() for record in caplog.records if ALERT in record.getMessage()]


@pytest.mark.parametrize("config", [AgentConfigModel(), WITH_FALLBACKS])
def test_a_429_from_any_sarvam_service_is_an_alert_even_behind_a_fallback(caplog, config):
    """A fallback adapter would hide the primary's errors from the session."""
    stt, llm, tts = build_stt(config), build_llm(config), build_tts(config)
    if config.fallback_llm:
        stt, llm, tts = stt._stt_instances[0], llm._llm_instances[0], tts._tts_instances[0]
    caplog.set_level(logging.ERROR)

    emit_error(stt, STTError, APIStatusError("too many requests", status_code=429))
    emit_error(llm, LLMError, APIStatusError("too many requests", status_code=429))
    emit_error(tts, TTSError, APIStatusError("too many requests", status_code=429))
    assert len(alerts(caplog)) == 3


def test_the_post_call_analysis_model_is_watched_too(caplog):
    caplog.set_level(logging.ERROR)
    llm = build_analysis_llm(AgentConfigModel())
    emit_error(llm, LLMError, APIStatusError("too many requests", status_code=429))
    assert len(alerts(caplog)) == 1


def test_other_failures_are_not_rate_limits(caplog):
    caplog.set_level(logging.ERROR)
    llm = build_llm(AgentConfigModel())
    emit_error(llm, LLMError, APIStatusError("server error", status_code=500))
    emit_error(llm, LLMError, APIConnectionError("no route"))
    assert alerts(caplog) == []


def test_a_429_wrapped_in_another_error_is_found():
    try:
        try:
            raise APIStatusError("too many requests", status_code=429)
        except APIStatusError as cause:
            raise APIStatusError("STT WebSocket session failed") from cause
    except APIStatusError as wrapped:
        assert is_rate_limited(wrapped)
    assert not is_rate_limited(None)
