"""The opening line of a call.

As *instructions* the model writes it: a model request of the whole prompt on every call,
and different words each time. *Verbatim* it is spoken exactly as written, with no model
request, and its audio is synthesised once and replayed: the cheapest way to open a call.

A recorded call always says so: a fixed notice after a verbatim greeting, or, for a
language with no default notice, an instruction for the model to say it.
"""

import hashlib
import logging
import threading
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass

from livekit import rtc
from livekit.agents import tts as tts_api
from livekit.agents.voice import AgentSession, SpeechHandle

logger = logging.getLogger("automitra.greeting")

DISCLOSURE_INSTRUCTIONS = (
    "In the same opening, tell the caller in a few words that this call is "
    "recorded, in the language you are speaking."
)

DEFAULT_RECORDING_NOTICES: dict[str, str] = {
    "hi-IN": "यह call record की जा रही है।",
    "en-IN": "This call is being recorded.",
}


@dataclass(frozen=True)
class Opening:
    """Exact words to speak, or instructions for the model."""

    text: str | None = None
    instructions: str | None = None


def plan_opening(
    greeting: str, *, mode: str, recorded: bool, notice: str = "", language: str = ""
) -> Opening:
    if mode != "verbatim":
        if recorded:
            return Opening(instructions=f"{greeting}\n\n{DISCLOSURE_INSTRUCTIONS}")
        return Opening(instructions=greeting)
    if not recorded:
        return Opening(text=greeting)
    notice_line = notice.strip() or DEFAULT_RECORDING_NOTICES.get(language, "")
    if not notice_line:
        return Opening(
            instructions=(
                "Say exactly this opening line, word for word: "
                f"{greeting}\n\n{DISCLOSURE_INSTRUCTIONS}"
            )
        )
    return Opening(text=f"{greeting} {notice_line}")


class AudioCache:
    """Synthesised audio keyed by the exact words and voice. Bounded, so a greeting
    personalised with each contact's name cannot grow it without limit."""

    def __init__(self, max_entries: int = 64) -> None:
        self._entries: OrderedDict[str, list[rtc.AudioFrame]] = OrderedDict()
        self._max_entries = max_entries
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
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)


GREETING_AUDIO = AudioCache()


async def cached_audio(
    tts: tts_api.TTS, text: str, key: str, cache: AudioCache = GREETING_AUDIO
) -> AsyncIterator[rtc.AudioFrame]:
    """A miss streams, so the first words play as soon as they exist (one-shot synthesis
    held a Bulbul greeting back almost five seconds). Audio is kept only when complete,
    so a greeting the caller talked over is not cached cut short."""
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
    """Queues the opening and returns at once.

    Never await the handle: on a call nobody answers it never resolves, which would
    hold the job open until the worker cancels it.
    """
    if opening.text is None:
        return session.generate_reply(instructions=opening.instructions)
    if session.tts is None:
        return session.say(opening.text)
    key = AudioCache.key(opening.text, voice)
    return session.say(opening.text, audio=cached_audio(session.tts, opening.text, key))
