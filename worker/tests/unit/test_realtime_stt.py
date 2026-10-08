import pytest
from livekit.agents import stt as stt_api
from livekit.plugins import sarvam

from automitra_worker.pipeline.realtime_stt import RealtimeSTT, find_realtime_stt, realtime_language


@pytest.fixture(autouse=True)
def sarvam_api_key(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")


class FakeStream:
    def __init__(self, *, closed: bool = False) -> None:
        self.flushes = 0
        self.closed = closed

    def flush(self) -> None:
        if self.closed:
            raise RuntimeError("stream is closed")
        self.flushes += 1


def realtime_stt() -> RealtimeSTT:
    return RealtimeSTT(model="saaras:v4", language="hi-IN", mode="codemix")


def test_it_ends_utterances_manually_on_the_fast_profile():
    options = realtime_stt()._opts
    assert (options.endpointing, options.stream_type, options.mode) == ("manual", "fast", "codemix")


@pytest.mark.parametrize(
    ("configured", "sent"), [("saaras:v4", "saaras:v4"), ("saaras:v3", "saaras:v3-realtime")]
)
def test_the_configured_model_runs_on_the_realtime_endpoint(configured, sent):
    assert RealtimeSTT(model=configured, language="hi-IN", mode="codemix").model == sent


def test_each_stream_connects_with_the_configured_model(monkeypatch):
    class Options:
        model = "saaras:v3-realtime"

    class Stream:
        _opts = Options()

    monkeypatch.setattr(sarvam.STTRealtime, "stream", lambda self, **kwargs: Stream())
    assert realtime_stt().stream()._opts.model == "saaras:v4"


@pytest.mark.parametrize(
    ("configured", "sent"),
    [("hi-IN", "hi-IN"), ("en-IN", "en-IN"), ("unknown", "auto"), ("fr-FR", "auto")],
)
def test_language_hints_it_cannot_take_fall_back_to_detection(configured, sent):
    assert realtime_language(configured) == sent


def test_end_of_speech_flushes_every_open_stream_and_forgets_closed_ones():
    stt = realtime_stt()
    live, other_live, closed = FakeStream(), FakeStream(), FakeStream(closed=True)
    for stream in (live, other_live, closed):
        stt._open_streams.add(stream)
    stt.end_of_speech()
    assert (live.flushes, other_live.flushes) == (1, 1)
    assert closed not in stt._open_streams


def test_it_is_found_directly_or_behind_a_fallback():
    realtime = realtime_stt()
    batch = sarvam.STT(model="saaras:v4", mode="codemix", language="hi-IN")
    assert find_realtime_stt(realtime) is realtime
    assert find_realtime_stt(stt_api.FallbackAdapter([realtime, batch])) is realtime
    assert find_realtime_stt(batch) is None
    assert find_realtime_stt(None) is None
