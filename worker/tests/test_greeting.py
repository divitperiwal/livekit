"""The opening line: what is said, and that its audio is paid for once.

A recorded caller must always be told, whichever way the greeting is said.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from livekit import rtc

from automitra_worker.greeting import AudioCache, Opening, cached_audio, plan_opening
from automitra_worker.recording import DISCLOSURE_INSTRUCTIONS

LINE = "नमस्कार, KBS Motors में आपका स्वागत है।"


def test_instructions_mode_is_what_it_always_was() -> None:
    assert plan_opening(LINE, mode="instructions", recorded=False) == Opening(instructions=LINE)
    recorded = plan_opening(LINE, mode="instructions", recorded=True)
    assert recorded.text is None and DISCLOSURE_INSTRUCTIONS in recorded.instructions


def test_verbatim_says_the_line_exactly() -> None:
    assert plan_opening(LINE, mode="verbatim", recorded=False) == Opening(text=LINE)


def test_verbatim_and_recorded_adds_the_language_default_notice() -> None:
    opening = plan_opening(LINE, mode="verbatim", recorded=True, language="hi-IN")
    assert opening.text == f"{LINE} यह call record की जा रही है।"


def test_the_agents_own_notice_wins() -> None:
    opening = plan_opening(
        LINE, mode="verbatim", recorded=True, notice="ये call record हो रही है।", language="hi-IN"
    )
    assert opening.text == f"{LINE} ये call record हो रही है।"


def test_a_language_without_a_notice_still_tells_the_caller() -> None:
    # No fixed Tamil notice on file: the model writes it, rather than the
    # caller being recorded without being told.
    opening = plan_opening("வணக்கம்", mode="verbatim", recorded=True, language="ta-IN")
    assert opening.text is None
    assert "வணக்கம்" in opening.instructions and DISCLOSURE_INSTRUCTIONS in opening.instructions


class FakeTTS:
    def __init__(self, frames: int = 3, streaming: bool = True) -> None:
        self.calls = 0
        self.frames = frames
        self.capabilities = SimpleNamespace(streaming=streaming)
        self.used: list[str] = []

    def _stream(self, kind: str):
        self.calls += 1
        self.used.append(kind)
        tts = self

        class Stream:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def push_text(self, text: str) -> None:
                pass

            def end_input(self) -> None:
                pass

            async def __aiter__(self):
                for _ in range(tts.frames):
                    yield SimpleNamespace(frame=rtc.AudioFrame.create(24000, 1, 240))

        return Stream()

    def stream(self):
        return self._stream("stream")

    def synthesize(self, text: str):
        return self._stream("synthesize")


async def drain(stream) -> int:
    return sum([1 async for _ in stream])


def test_the_audio_is_synthesised_once_and_replayed() -> None:
    cache, tts = AudioCache(), FakeTTS()
    key = AudioCache.key(LINE, ("bulbul:v3", "ritu", "hi-IN", 1.0))
    assert asyncio.run(drain(cached_audio(tts, LINE, key, cache))) == 3
    assert asyncio.run(drain(cached_audio(tts, LINE, key, cache))) == 3
    assert tts.calls == 1


def test_a_miss_streams_so_the_first_words_are_not_held_back() -> None:
    cache, tts = AudioCache(), FakeTTS()
    asyncio.run(drain(cached_audio(tts, LINE, "k", cache)))
    assert tts.used == ["stream"]


def test_a_voice_that_cannot_stream_is_synthesised_whole() -> None:
    cache, tts = AudioCache(), FakeTTS(streaming=False)
    assert asyncio.run(drain(cached_audio(tts, LINE, "k", cache))) == 3
    assert tts.used == ["synthesize"]


def test_a_greeting_cut_short_is_not_kept() -> None:
    cache, tts = AudioCache(), FakeTTS()
    key = AudioCache.key(LINE, ("v",))

    async def first_frame_only() -> None:
        stream = cached_audio(tts, LINE, key, cache)
        await stream.__anext__()
        await stream.aclose()

    asyncio.run(first_frame_only())
    assert cache.get(key) is None


def test_a_different_voice_is_a_different_entry() -> None:
    assert AudioCache.key(LINE, ("bulbul:v3", "ritu")) != AudioCache.key(LINE, ("bulbul:v3", "anushka"))


def test_the_cache_is_bounded() -> None:
    cache = AudioCache(max_entries=2)
    for name in ("a", "b", "c"):
        cache.put(name, [])
    assert cache.get("a") is None and cache.get("c") == []
