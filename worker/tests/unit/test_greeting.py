from types import SimpleNamespace

from livekit import rtc

from automitra_worker.pipeline.greeting import (
    DISCLOSURE_INSTRUCTIONS,
    AudioCache,
    Opening,
    cached_audio,
    plan_opening,
)

LINE = "नमस्कार, KBS Motors में आपका स्वागत है।"


def test_an_instruction_greeting_asks_the_model_to_disclose_recording():
    assert plan_opening(LINE, mode="instructions", recorded=False) == Opening(instructions=LINE)
    recorded = plan_opening(LINE, mode="instructions", recorded=True)
    assert recorded.text is None and DISCLOSURE_INSTRUCTIONS in recorded.instructions


def test_a_verbatim_greeting_is_said_exactly():
    assert plan_opening(LINE, mode="verbatim", recorded=False) == Opening(text=LINE)


def test_a_recorded_verbatim_greeting_adds_the_languages_default_notice():
    assert plan_opening(LINE, mode="verbatim", recorded=True, language="hi-IN").text == (
        f"{LINE} यह call record की जा रही है।"
    )


def test_the_agents_own_notice_wins():
    opening = plan_opening(
        LINE, mode="verbatim", recorded=True, notice="ये call record हो रही है।", language="hi-IN"
    )
    assert opening.text == f"{LINE} ये call record हो रही है।"


def test_a_language_without_a_default_notice_still_tells_the_caller():
    opening = plan_opening("வணக்கம்", mode="verbatim", recorded=True, language="ta-IN")
    assert opening.text is None
    assert "வணக்கம்" in opening.instructions and DISCLOSURE_INSTRUCTIONS in opening.instructions


class FakeTTS:
    def __init__(self, frames: int = 3, streaming: bool = True) -> None:
        self.frames = frames
        self.capabilities = SimpleNamespace(streaming=streaming)
        self.used: list[str] = []

    def _open(self, kind: str):
        self.used.append(kind)
        frame_count = self.frames

        class Stream:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exception):
                return False

            def push_text(self, text: str) -> None:
                pass

            def end_input(self) -> None:
                pass

            async def __aiter__(self):
                for _ in range(frame_count):
                    yield SimpleNamespace(frame=rtc.AudioFrame.create(24000, 1, 240))

        return Stream()

    def stream(self):
        return self._open("stream")

    def synthesize(self, text: str):
        return self._open("synthesize")


async def frame_count(audio) -> int:
    return sum([1 async for _ in audio])


async def test_the_audio_is_synthesised_once_and_replayed():
    cache, tts = AudioCache(), FakeTTS()
    key = AudioCache.key(LINE, ("bulbul:v3", "ritu", "hi-IN", 1.0))
    assert await frame_count(cached_audio(tts, LINE, key, cache)) == 3
    assert await frame_count(cached_audio(tts, LINE, key, cache)) == 3
    assert tts.used == ["stream"]


async def test_a_voice_that_cannot_stream_is_synthesised_whole():
    tts = FakeTTS(streaming=False)
    assert await frame_count(cached_audio(tts, LINE, "key", AudioCache())) == 3
    assert tts.used == ["synthesize"]


async def test_a_greeting_cut_short_is_not_cached():
    cache = AudioCache()
    audio = cached_audio(FakeTTS(), LINE, "key", cache)
    await audio.__anext__()
    await audio.aclose()
    assert cache.get("key") is None


def test_a_different_voice_is_a_different_entry():
    assert AudioCache.key(LINE, ("bulbul:v3", "ritu")) != AudioCache.key(
        LINE, ("bulbul:v3", "priya")
    )


def test_the_cache_is_bounded():
    cache = AudioCache(max_entries=2)
    for key in ("a", "b", "c"):
        cache.put(key, [])
    assert cache.get("a") is None and cache.get("c") == []
