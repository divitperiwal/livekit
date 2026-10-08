"""Releases one reply to synthesis sentence by sentence, as the rate ceiling allows.

Sentences, so a reply the ceiling cuts short ends where a sentence ends. Synthesis works
a sentence at a time anyway, so this adds no latency. A sentence that does not fit yet
waits up to MAX_PAUSE_SECONDS; one that still does not fit ends the reply, and the rest
is dropped: never synthesised, never billed, never in the transcript.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable

from automitra_worker.cost.rate_ceiling import RateCeiling

# A long silence mid-reply is worse than a reply that ends early.
MAX_PAUSE_SECONDS = 3.0

# After a full stop, question or exclamation mark, a danda, or a line break.
SENTENCE_END = re.compile(r"(?<=[.!?।॥\n])\s+")
# A model that never punctuates must not hold up speech indefinitely.
MAX_PIECE_CHARS = 200


class SentenceGate:
    def __init__(
        self,
        ceiling: RateCeiling,
        elapsed: Callable[[], float],
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        max_pause: float = MAX_PAUSE_SECONDS,
    ) -> None:
        self._ceiling = ceiling
        self._elapsed = elapsed
        self._sleep = sleep
        self._max_pause = max_pause
        self._buffer = ""
        self.stopped = False
        self.released_chars = 0
        self.dropped_chars = 0

    def split(self, text: str) -> list[str]:
        """Add streamed text; return the sentences it completes."""
        self._buffer += text
        pieces = SENTENCE_END.split(self._buffer)
        self._buffer = pieces.pop()
        while len(self._buffer) > MAX_PIECE_CHARS:
            cut = self._buffer.rfind(" ", 0, MAX_PIECE_CHARS)
            if cut <= 0:
                cut = MAX_PIECE_CHARS
            pieces.append(self._buffer[:cut])
            self._buffer = self._buffer[cut:].lstrip()
        # Each keeps a trailing space so the next does not run into it.
        return [piece + " " for piece in pieces if piece.strip()]

    def rest(self) -> list[str]:
        rest, self._buffer = self._buffer, ""
        return [rest] if rest.strip() else []

    async def admit(self, sentence: str) -> bool:
        if self.stopped:
            self.dropped_chars += len(sentence)
            return False
        chars = len(sentence)
        is_opening_sentence = self.released_chars == 0
        if not await self._fits(chars, overdraft=is_opening_sentence):
            self.stopped = True
            self.dropped_chars += chars
            return False
        self._ceiling.reserve(chars)
        self.released_chars += chars
        return True

    async def may_request(self) -> bool:
        return await self._fits(0, overdraft=True)

    async def _fits(self, chars: int, overdraft: bool) -> bool:
        wait = self._ceiling.wait_for(chars, self._elapsed(), overdraft)
        if 0 < wait <= self._max_pause:
            # A little over, so float rounding cannot leave it a hair short.
            await self._sleep(wait + 0.05)
            wait = self._ceiling.wait_for(chars, self._elapsed(), overdraft)
        return wait <= 0
