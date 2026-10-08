"""The Agent a call runs: every reply passes the rate ceiling's sentence gate.

A sentence the ceiling cannot afford is dropped here, on its way out of the model, so it
is never synthesised and never enters the transcript or the model's memory of what it
said. Everything that does reach synthesis is counted on the way in.

Steering (be brief, wind down) is appended at the end of each request rather than
written into the system prompt. Sarvam's server caches the longest prefix a request
shares with earlier ones; rewriting the system prompt, which comes first, would discard
that cache for the whole conversation on every change.
"""

import logging
from collections.abc import AsyncIterable, AsyncIterator, Callable
from typing import Any

from livekit import rtc
from livekit.agents import Agent, FlushSentinel, ModelSettings, llm as llm_api

from automitra_worker.cost.rate_ceiling import RateCeiling
from automitra_worker.cost.sentence_gate import SentenceGate

logger = logging.getLogger("automitra.voice_assistant")


class VoiceAssistant(Agent):
    def __init__(
        self,
        instructions: str,
        tools: list[Any] | None = None,
        *,
        ceiling: RateCeiling | None = None,
        elapsed: Callable[[], float] = lambda: 0.0,
    ) -> None:
        super().__init__(instructions=instructions, tools=tools or [])
        self._ceiling = ceiling
        self._elapsed = elapsed
        self.steering = ""

    async def llm_node(
        self,
        chat_ctx: llm_api.ChatContext,
        tools: list[llm_api.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterator[llm_api.ChatChunk | str | FlushSentinel]:
        if self.steering:
            # A copy, so the note shapes this reply without entering the history.
            chat_ctx = chat_ctx.copy()
            chat_ctx.add_message(role="system", content=[self.steering])
        stream = Agent.default.llm_node(self, chat_ctx, tools, model_settings)
        if self._ceiling is None:
            async for chunk in stream:
                yield chunk
            return

        self._ceiling.begin_reply()
        gate = SentenceGate(self._ceiling, self._elapsed)
        if not await gate.may_request():
            # A request is billed whether or not its reply is spoken.
            logger.warning("rate ceiling: no room for a model request; skipping this turn")
            await stream.aclose()
            return

        async for chunk in stream:
            text, passthrough = _split_text_from(chunk)
            if passthrough is not None:
                yield passthrough
            for sentence in gate.split(text):
                if await gate.admit(sentence):
                    yield sentence
        for sentence in gate.rest():
            if await gate.admit(sentence):
                yield sentence

        if gate.dropped_chars:
            logger.info(
                "rate ceiling: held back %d of %d characters of a reply",
                gate.dropped_chars,
                gate.dropped_chars + gate.released_chars,
            )

    async def tts_node(
        self, text: AsyncIterable[str], model_settings: ModelSettings
    ) -> AsyncIterator[rtc.AudioFrame]:
        source = text if self._ceiling is None else _counted(text, self._ceiling)
        async for frame in Agent.default.tts_node(self, source, model_settings):
            yield frame


def _split_text_from(chunk: Any) -> tuple[str, Any]:
    """A chunk's text goes through the gate; its tool calls and usage go on regardless."""
    if isinstance(chunk, str):
        return chunk, None
    if isinstance(chunk, llm_api.ChatChunk) and chunk.delta and chunk.delta.content:
        rest = chunk.delta.model_copy(update={"content": None})
        keeps_something = bool(rest.tool_calls) or chunk.usage is not None
        return chunk.delta.content, chunk.model_copy(
            update={"delta": rest}
        ) if keeps_something else None
    return "", chunk


async def _counted(text: AsyncIterable[str], ceiling: RateCeiling) -> AsyncIterator[str]:
    async for chunk in text:
        ceiling.count_tts(len(chunk))
        yield chunk
