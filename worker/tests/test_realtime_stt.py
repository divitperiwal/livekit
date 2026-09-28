"""Sarvam realtime STT, finalised by the session's VAD rather than its own.

Measured, its own voice detection waits about a second and a half before a
final transcript; flushed on the VAD's end of speech it is about 0.45 s. The
flush is the whole point, so it is what these check.
"""

from __future__ import annotations

import pytest
from livekit.agents import stt as stt_api
from livekit.plugins import sarvam

from automitra_worker.agent_config_model import AgentConfigModel
from automitra_worker.realtime_stt import RealtimeSTT, find_realtime_stt, realtime_language


@pytest.fixture(autouse=True)
def api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")


class FakeStream:
    def __init__(self, *, closed: bool = False) -> None:
        self.flushes = 0
        self.closed = closed

    def flush(self) -> None:
        if self.closed:
            raise RuntimeError("stream is closed")
        self.flushes += 1


def test_realtime_is_on_unless_switched_off() -> None:
    assert AgentConfigModel.model_validate({}).stt_realtime is True
    assert AgentConfigModel.model_validate({"stt_realtime": False}).stt_realtime is False


def test_it_ends_utterances_manually_on_the_fast_profile() -> None:
    stt = RealtimeSTT(model="saaras:v4", language="hi-IN", mode="codemix")
    assert (stt._opts.endpointing, stt._opts.stream_type, stt._opts.mode) == ("manual", "fast", "codemix")


@pytest.mark.parametrize(("configured", "sent"), [("saaras:v4", "saaras:v4"), ("saaras:v3", "saaras:v3-realtime")])
def test_the_configured_model_runs_on_the_realtime_endpoint(configured: str, sent: str) -> None:
    # v4, not the plugin's default v3-realtime: on the same audio v3-realtime
    # wrote "XUV 3XO" as "एक्स यू वी थ्री एक्स ओ".
    assert RealtimeSTT(model=configured, language="hi-IN", mode="codemix").model == sent


async def test_each_stream_connects_with_the_configured_model(monkeypatch: pytest.MonkeyPatch) -> None:
    stt = RealtimeSTT(model="saaras:v4", language="hi-IN", mode="codemix")

    class Opts:
        model = "saaras:v3-realtime"

    class Stream:
        _opts = Opts()

    monkeypatch.setattr(sarvam.STTRealtime, "stream", lambda self, **kwargs: Stream())
    assert stt.stream()._opts.model == "saaras:v4"


@pytest.mark.parametrize(
    ("configured", "sent"),
    [("hi-IN", "hi-IN"), ("en-IN", "en-IN"), ("unknown", "auto"), ("fr-FR", "auto")],
)
def test_language_hints_it_cannot_take_fall_back_to_detection(configured: str, sent: str) -> None:
    assert realtime_language(configured) == sent


def test_end_of_speech_flushes_every_open_stream() -> None:
    stt = RealtimeSTT(model="saaras:v4", language="hi-IN", mode="codemix")
    first, second = FakeStream(), FakeStream()
    stt._open.add(first)  # type: ignore[arg-type]
    stt._open.add(second)  # type: ignore[arg-type]
    stt.end_of_speech()
    assert (first.flushes, second.flushes) == (1, 1)


def test_a_stream_closed_meanwhile_is_skipped_and_forgotten() -> None:
    stt = RealtimeSTT(model="saaras:v4", language="hi-IN", mode="codemix")
    gone, live = FakeStream(closed=True), FakeStream()
    stt._open.add(gone)  # type: ignore[arg-type]
    stt._open.add(live)  # type: ignore[arg-type]
    stt.end_of_speech()
    assert live.flushes == 1
    assert gone not in stt._open


def test_it_is_found_directly_or_behind_a_fallback() -> None:
    realtime = RealtimeSTT(model="saaras:v4", language="hi-IN", mode="codemix")
    assert find_realtime_stt(realtime) is realtime
    batch = sarvam.STT(model="saaras:v4", mode="codemix", language="hi-IN")
    assert find_realtime_stt(stt_api.FallbackAdapter([realtime, batch])) is realtime
    assert find_realtime_stt(batch) is None
    assert find_realtime_stt(None) is None
