"""The opening line of a call.

Said one of two ways. As *instructions*, the model writes the greeting, which
costs a model request of the whole prompt on every call and gives words that
differ each time. *Verbatim*, it is spoken exactly as written: no model
request, and because the words never change, the audio is synthesised once and
replayed. On a short call the greeting is a large share of what text-to-speech
costs, so this is the cheapest way to open one.

A recorded call must say so. Verbatim, that is a fixed notice after the
greeting -- the agent's own, or a default for its language. A language with no
default falls back to having the model write it, rather than saying nothing.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass

from livekit import rtc
from livekit.agents import tts as tts_api
from livekit.agents.voice import AgentSession, SpeechHandle

from .recording import DISCLOSURE_INSTRUCTIONS

logger = logging.getLogger("automitra.greeting")

DEFAULT_RECORDING_NOTICES: dict[str, str] = {
    "hi-IN": "यह call record की जा रही है।",
    "en-IN": "This call is being recorded.",
}


@dataclass(frozen=True)
class Opening:
    """What to open the call with: exact words, or instructions for the model."""

    text: str | None = None
    instructions: str | None = None


def plan_opening(
    greeting: str,
    *,
    mode: str,
    recorded: bool,
    notice: str = "",
    language: str = "",
) -> Opening:
    if mode != "verbatim":
        if recorded:
            return Opening(instructions=f"{greeting}\n\n{DISCLOSURE_INSTRUCTIONS}")
        return Opening(instructions=greeting)
    if not recorded:
        return Opening(text=greeting)
    line = notice.strip() or DEFAULT_RECORDING_NOTICES.get(language, "")
    if not line:
        return Opening(
            instructions=(
                "Say exactly this opening line, word for word: "
                f"{greeting}\n\n{DISCLOSURE_INSTRUCTIONS}"
            )
        )
    return Opening(text=f"{greeting} {line}")


class AudioCache:
    """Synthesised audio by the exact words and voice that produced it.

    Held in memory and bounded, so a greeting personalised with each contact's
    name cannot grow it without limit. A worker process serves call after call,
    so one synthesis serves every call after the first.
    """

    def __init__(self, max_entries: int = 64) -> None:
        self._entries: OrderedDict[str, list[rtc.AudioFrame]] = OrderedDict()
        self._max = max_entries
        # Jobs can run on threads of one process, each with its own loop.
        self._lock = threading.Lock()

    @staticmethod
    def key(text: str, voice: tuple[object, ...]) -> str:
        return hashlib.sha256(repr((voice, text)).encode()).hexdigest()

    def get(self, key: str) -> list[rtc.AudioFrame] | None:
        with self._lock:
            frames = self._entries.get(key)
            if frames is not None:
                self._entries.move_to_end(key)
            return frames

    def put(self, key: str, frames: list[rtc.AudioFrame]) -> None:
        with self._lock:
            self._entries[key] = frames
            self._entries.move_to_end(key)
            while len(self._entries) > self._max:
                self._entries.popitem(last=False)


GREETING_AUDIO = AudioCache()


async def cached_audio(
    tts: tts_api.TTS, text: str, key: str, cache: AudioCache = GREETING_AUDIO
) -> AsyncIterator[rtc.AudioFrame]:
    """The words as audio: from the cache, or synthesised and then kept.

    A miss streams, so the caller hears the first words as soon as they exist:
    one-shot synthesis returns nothing until the whole line is done, which held
    a Bulbul greeting back almost five seconds. The audio is kept only once
    complete -- a greeting the caller talked over is not stored cut short.
    """
    frames = cache.get(key)
    if frames is not None:
        for frame in frames:
            yield frame
        return
    collected: list[rtc.AudioFrame] = []
    if tts.capabilities.streaming:
        async with tts.stream() as stream:
            stream.push_text(text)
            stream.end_input()
            async for chunk in stream:
                collected.append(chunk.frame)
                yield chunk.frame
    else:
        async with tts.synthesize(text) as stream:
            async for chunk in stream:
                collected.append(chunk.frame)
                yield chunk.frame
    if collected:
        cache.put(key, collected)
        logger.info("cached the opening line's audio (%d frames)", len(collected))


def speak_opening(
    session: AgentSession, opening: Opening, voice: tuple[object, ...]
) -> SpeechHandle:
    """Queues the opening and returns at once; the session owns the speech."""
    if opening.text is None:
        return session.generate_reply(instructions=opening.instructions)
    tts = session.tts
    if tts is None:
        return session.say(opening.text)
    key = AudioCache.key(opening.text, voice)
    return session.say(opening.text, audio=cached_audio(tts, opening.text, key))
