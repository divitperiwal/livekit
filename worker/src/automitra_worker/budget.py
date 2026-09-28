"""A hard ceiling on what a single call may cost.

Sarvam bills per second, per character and per token, so the cost of a call is
not known until it ends. This module makes it bounded instead: usage is costed
continuously during the call and the agent is steered -- then stopped -- before
it can exceed a budget you set.

The ceiling is enforced in three stages, because a call that simply cuts out
mid-sentence is a worse product than one that wraps up:

    warn   the agent is told to be brief and wind the conversation down
    wrap   the agent says a closing line and the call ends gracefully
    hard   the session is closed immediately, mid-sentence if necessary

The hard stop exists only as a backstop for a call that ignores the wrap stage
(a long synthesis already in flight, a model that will not stop talking). In
normal operation the wrap stage ends the call and the hard stop never fires.

The physical ceiling matters here: an agent cannot speak faster than speech, so
TTS -- the dominant cost -- is capped at roughly Rs 2.70 per minute of wall
clock whatever happens. A budget therefore also implies a rough floor on call
duration, which :meth:`CallBudget.implied_minutes` reports.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import IntEnum

from .costs import (
    LLM_INR_CACHED_PER_MTOK,
    LLM_INR_PER_MTOK,
    STT_INR_PER_MIN,
    TTS_INR_PER_CHAR,
)

logger = logging.getLogger("automitra.budget")

# Worst-case TTS spend per minute of wall clock: the agent talking continuously
# at ~900 characters/minute. Used to translate a budget into a duration floor.
MAX_TTS_CHARS_PER_MIN = 900.0

# A farewell line is roughly this long. The wrap stage must trip while at least
# this much budget remains, or there is nothing left to say goodbye with.
FAREWELL_CHARS = 160.0

# Usage is reported per turn, and one agent reply can be several hundred
# characters, so the wrap stage has to trip a whole turn's worth of spend before
# the ceiling -- a percentage gap narrower than one turn gets skipped entirely.
TYPICAL_TURN_CHARS = 400.0


class Stage(IntEnum):
    """How far through its budget a call is. Ordered, so it only moves up."""

    OK = 0
    WARN = 1
    WRAP = 2
    HARD = 3


@dataclass
class CallBudget:
    """Tracks spend during a call and reports which stage it has reached.

    This is pure bookkeeping -- it decides *when* a limit is hit, not what to
    do about it, so it can be unit tested without a session. The agent wires
    the stages to actual behaviour.

    Set ``limit_inr`` to 0 or below to disable the ceiling entirely.
    """

    limit_inr: float
    stt_model: str
    tts_model: str
    llm_model: str

    # Fractions of the budget at which each stage trips.
    warn_at: float = 0.70
    wrap_at: float = 0.90

    spent_inr: float = field(default=0.0, init=False)
    stage: Stage = field(default=Stage.OK, init=False)

    @property
    def enabled(self) -> bool:
        return self.limit_inr > 0

    @property
    def reserve_inr(self) -> float:
        """Spend to keep in hand so the call can still end gracefully.

        Enough to say the farewell, plus one typical turn, because usage is
        reported per turn: by the time a metrics event shows the budget is
        nearly gone, another reply may already be in flight. Without this the
        wrap and hard stages can trip on the same event and the call is cut off
        mid-sentence instead of closing properly.
        """
        return TTS_INR_PER_CHAR.get(self.tts_model, 0.0) * (
            FAREWELL_CHARS + TYPICAL_TURN_CHARS
        )

    @property
    def remaining_inr(self) -> float:
        return max(0.0, self.limit_inr - self.spent_inr)

    @property
    def fraction_used(self) -> float:
        if not self.enabled:
            return 0.0
        return self.spent_inr / self.limit_inr

    def validate(self) -> None:
        """Reject a budget too small to run a call, at startup rather than mid-call."""
        if not self.enabled:
            return
        # Below roughly twice the reserve the call would wrap on its first or
        # second turn, which is not a conversation.
        floor = self.reserve_inr * 2
        if self.limit_inr < floor:
            raise ValueError(
                f"CALL_BUDGET_INR={self.limit_inr:.2f} is too small to hold a "
                f"conversation: Rs {self.reserve_inr:.2f} is reserved to end the "
                f"call gracefully, so the agent would wrap up almost immediately. "
                f"Use at least Rs {floor:.2f}, or 0 to disable the ceiling."
            )

    def implied_minutes(self) -> float:
        """Shortest call this budget could possibly afford.

        The worst case is the agent talking non-stop, so this is the duration
        at which even a maximally chatty call stays inside the ceiling. A real
        call, where the user does half the talking, lasts considerably longer.
        """
        per_min = (
            STT_INR_PER_MIN[self.stt_model]
            + TTS_INR_PER_CHAR[self.tts_model] * MAX_TTS_CHARS_PER_MIN
        )
        return self.limit_inr / per_min if per_min else float("inf")

    def update(self, summary: object) -> Stage:
        """Recost the call from a usage summary and return the current stage.

        The stage never moves backwards: once a call has been told to wrap up,
        a later summary cannot walk it back to OK.
        """
        if not self.enabled:
            return Stage.OK

        self.spent_inr = _cost_so_far(
            summary,
            stt_model=self.stt_model,
            tts_model=self.tts_model,
            llm_model=self.llm_model,
        )

        used = self.fraction_used
        # Wrap on whichever comes first: the configured fraction, or the point
        # where only the reserve is left. On a small budget the reserve binds
        # first, which is what keeps the farewell affordable.
        wrap_threshold = min(
            self.wrap_at * self.limit_inr, self.limit_inr - self.reserve_inr
        )
        if used >= 1.0:
            reached = Stage.HARD
        elif self.spent_inr >= wrap_threshold:
            reached = Stage.WRAP
        elif used >= self.warn_at:
            reached = Stage.WARN
        else:
            reached = Stage.OK

        if reached > self.stage:
            self.stage = reached
            logger.info(
                "call budget %s: Rs %.3f of Rs %.2f (%.0f%%)",
                reached.name,
                self.spent_inr,
                self.limit_inr,
                used * 100,
            )
        return self.stage


def _cost_so_far(
    summary: object, *, stt_model: str, tts_model: str, llm_model: str
) -> float:
    """Cost of usage so far, in INR.

    Separate from ``costs.actual_cost`` because this runs on every metrics
    event during a live call: it must not raise on an unknown model (the call
    is already in progress), and it prices cached input tokens at the cheaper
    rate so the budget is not spent faster on paper than in reality.
    """
    stt_rate = STT_INR_PER_MIN.get(stt_model, 0.0)
    tts_rate = TTS_INR_PER_CHAR.get(tts_model, 0.0)
    llm_in, llm_out = LLM_INR_PER_MTOK.get(llm_model, (0.0, 0.0))
    llm_cached = LLM_INR_CACHED_PER_MTOK.get(llm_model, llm_in)

    stt_seconds = float(getattr(summary, "stt_audio_duration", 0.0) or 0.0)
    tts_chars = float(getattr(summary, "tts_characters_count", 0) or 0)
    prompt_tokens = float(getattr(summary, "llm_prompt_tokens", 0) or 0)
    cached_tokens = float(getattr(summary, "llm_prompt_cached_tokens", 0) or 0)
    completion_tokens = float(getattr(summary, "llm_completion_tokens", 0) or 0)

    # Cached tokens are reported as a subset of prompt tokens, not in addition.
    fresh_tokens = max(0.0, prompt_tokens - cached_tokens)

    return (
        stt_rate * (stt_seconds / 60.0)
        + tts_rate * tts_chars
        + (
            llm_in * fresh_tokens
            + llm_cached * cached_tokens
            + llm_out * completion_tokens
        )
        / 1e6
    )


# Added to the end of each request once the warn stage trips. The agent
# keeps its persona but is told the call is nearly over, so it stops opening
# new threads of conversation.
WARN_INSTRUCTIONS = """

URGENT -- the call is nearly out of time. From now on: keep every reply to one \
short sentence. Do not start new topics, do not offer further help, and do not \
ask follow-up questions unless you need one detail to finish what the user \
already asked. Bring the conversation to a natural close."""


# Added to the end of each request while the call runs close to its per-minute
# ceiling, and taken off once it has come back down. It makes the agent cheaper
# so the hard limit below rarely has to hold anything back.
RATE_INSTRUCTIONS = """

You are talking too much. From now on every reply must be a single short \
sentence: the next step, or the one question you need. No preamble, no \
sympathy, no restating what the user said."""


# The most any call may cost per minute, in INR, whatever an agent is
# configured with. A configured ceiling of 0 means this one; a higher one is
# lowered to it.
PLATFORM_MAX_INR_PER_MIN = 2.0

# The lowest ceiling an agent may ask for. Speech-to-text alone is a fixed
# Rs 0.50/min; at Rs 1/min what is left buys the agent about 160 characters of
# speech a minute, and any lower it could barely speak at all.
PLATFORM_MIN_INR_PER_MIN = 1.0

# The allowance never counts less than this much of the call. The opening line
# is spoken in the first seconds, and measured against so little time any
# greeting would be "over the rate". Thirty seconds is also the shortest call
# that is billed, so the ceiling holds per billed minute from the first second,
# and per actual minute on any call longer than this.
HEAD_START_SECONDS = 30.0

# The longest the agent may pause between sentences waiting for its allowance
# to catch up. Past this the rest of the reply is dropped instead: a long
# silence mid-reply is worse than a reply that ends early.
MAX_PAUSE_SECONDS = 3.0

# How far over the ceiling the first sentence of a reply, and the model request
# behind it, may go. Held to the ceiling alone, an ordinary call runs out of
# allowance within a few turns and the agent answers the caller with silence,
# which reads as a dropped call. With this, a reply over the rate is cut to one
# sentence instead; everything after that sentence is still held to the
# ceiling. It is still a hard limit, so a caller who keeps interrupting cannot
# run the cost up without bound.
OPENING_OVERDRAFT_INR_PER_MIN = 0.5

# Held back for the next model request, which is billed whether or not any of
# its reply is spoken. Grown to the largest request seen as the context grows.
MIN_LLM_MARGIN_PROMPT_TOKENS = 3000
MIN_LLM_MARGIN_COMPLETION_TOKENS = 150

# Where a reply may be cut into separately admitted pieces: after a full stop,
# question or exclamation mark, a danda, or a line break, before whitespace.
_SENTENCE_END = re.compile(r"(?<=[.!?।॥\n])\s+")

# A run of text with no sentence end is released in pieces no longer than this,
# so a model that never punctuates does not hold up speech indefinitely.
_MAX_PIECE_CHARS = 200


def effective_ceiling(configured_inr_per_min: float) -> float:
    """The ceiling a call actually runs under: never above the platform's."""
    if configured_inr_per_min <= 0:
        return PLATFORM_MAX_INR_PER_MIN
    return min(configured_inr_per_min, PLATFORM_MAX_INR_PER_MIN)


@dataclass
class RateCeiling:
    """Holds the cost per minute of a call under a hard ceiling.

    The guarantee: at every moment of the call, what has been spent is no more
    than ``ceiling`` times the minutes elapsed (counting at least
    :data:`HEAD_START_SECONDS`), except that the first sentence of each reply
    may take it up to ``ceiling + overdraft`` so that no turn goes unanswered.
    Because it holds at every moment, it holds at whatever moment the caller
    hangs up.

    Speech-to-text runs on the whole call and cannot be throttled, so it is
    charged against the ceiling first, leaving ``ceiling - STT`` per minute for
    what the agent says and the model requests behind it. Text-to-speech is the
    lever, and it is pulled *before* the money is spent: each sentence of a
    reply is admitted only if it fits (see :class:`SentenceGate`), so text over
    the limit is never sent to be synthesised and never billed.

    A model request is billed whether or not its reply is spoken, so admitting
    a sentence also leaves room for the next request, and a request is only
    made once that room exists.

    This is bookkeeping only; the agent wires it into its pipeline.
    """

    ceiling_inr_per_min: float
    stt_model: str
    tts_model: str
    llm_model: str

    # When the prompt steering switches on, and back off, as a fraction of the
    # allowance used. Apart, so it does not flap on every turn.
    tighten_at: float = 0.80
    relax_at: float = 0.60
    overdraft_inr_per_min: float = OPENING_OVERDRAFT_INR_PER_MIN

    tightened: bool = field(default=False, init=False)
    # Characters sent to be synthesised, counted as they are sent.
    _tts_chars: float = field(default=0.0, init=False)
    # Admitted by the gate but not yet seen on the way into synthesis.
    _reserved_chars: float = field(default=0.0, init=False)
    _measured_tts_chars: float = field(default=0.0, init=False)
    _stt_seconds: float = field(default=0.0, init=False)
    _llm_inr: float = field(default=0.0, init=False)
    _largest_request_inr: float = field(default=0.0, init=False)

    @property
    def stt_inr_per_min(self) -> float:
        return STT_INR_PER_MIN.get(self.stt_model, 0.0)

    @property
    def tts_inr_per_char(self) -> float:
        return TTS_INR_PER_CHAR.get(self.tts_model, 0.0)

    @property
    def llm_margin_inr(self) -> float:
        """Room kept for the next model request."""
        llm_in, llm_out = LLM_INR_PER_MTOK.get(self.llm_model, (0.0, 0.0))
        floor = (
            llm_in * MIN_LLM_MARGIN_PROMPT_TOKENS
            + llm_out * MIN_LLM_MARGIN_COMPLETION_TOKENS
        ) / 1e6
        # The context only grows, so the next request is larger than the last.
        return max(floor, self._largest_request_inr * 1.25)

    def validate(self) -> None:
        """Reject a ceiling that speech-to-text alone would break."""
        floor = self.stt_inr_per_min
        if self.ceiling_inr_per_min <= floor:
            raise ValueError(
                f"max_inr_per_min={self.ceiling_inr_per_min:.2f} is at or below "
                f"the Rs {floor:.2f}/min that speech-to-text costs on its own, so "
                "no amount of brevity could reach it."
            )

    # --- measurement ------------------------------------------------------

    def count_tts(self, chars: int) -> None:
        """Characters on their way into synthesis, as they are sent."""
        self._tts_chars += chars
        self._reserved_chars = max(0.0, self._reserved_chars - chars)

    def observe(self, summary: object) -> None:
        """Take in the usage measured so far."""
        self._measured_tts_chars = float(
            getattr(summary, "tts_characters_count", 0) or 0
        )
        self._stt_seconds = float(getattr(summary, "stt_audio_duration", 0.0) or 0.0)
        llm_in, llm_out = LLM_INR_PER_MTOK.get(self.llm_model, (0.0, 0.0))
        llm_cached = LLM_INR_CACHED_PER_MTOK.get(self.llm_model, llm_in)
        prompt = float(getattr(summary, "llm_prompt_tokens", 0) or 0)
        cached = float(getattr(summary, "llm_prompt_cached_tokens", 0) or 0)
        completion = float(getattr(summary, "llm_completion_tokens", 0) or 0)
        self._llm_inr = (
            llm_in * max(0.0, prompt - cached)
            + llm_cached * cached
            + llm_out * completion
        ) / 1e6

    def observe_request(
        self, prompt_tokens: int, cached_tokens: int, completion_tokens: int
    ) -> None:
        """Take in one model request, to size the room kept for the next."""
        llm_in, llm_out = LLM_INR_PER_MTOK.get(self.llm_model, (0.0, 0.0))
        llm_cached = LLM_INR_CACHED_PER_MTOK.get(self.llm_model, llm_in)
        fresh = max(0, prompt_tokens - cached_tokens)
        cost = (
            llm_in * fresh + llm_cached * cached_tokens + llm_out * completion_tokens
        ) / 1e6
        self._largest_request_inr = max(self._largest_request_inr, cost)

    def begin_reply(self) -> None:
        """A new reply starts: anything reserved for an earlier one is settled.

        Either it reached synthesis and was counted there, or the reply was
        interrupted before it did and was never billed.
        """
        self._reserved_chars = 0.0

    # --- the ceiling ------------------------------------------------------

    def _net_rate_per_second(self, overdraft: bool = False) -> float:
        """How fast the allowance for everything but STT grows."""
        ceiling = self.ceiling_inr_per_min
        if overdraft:
            ceiling += self.overdraft_inr_per_min
        return (ceiling - self.stt_inr_per_min) / 60.0

    def _allowance_inr(self, elapsed_seconds: float, overdraft: bool = False) -> float:
        """What may be spent, other than on STT, now and at every later moment.

        During the head start the allowance is flat while STT keeps accruing,
        so the binding moment for anything spent early is the end of the head
        start rather than now. Taking the later of the two covers both.
        """
        seconds = max(elapsed_seconds, HEAD_START_SECONDS)
        # STT beyond wall clock would be odd, but it costs what it costs.
        overrun = max(0.0, self._stt_seconds - max(elapsed_seconds, 0.0))
        return (
            self._net_rate_per_second(overdraft) * seconds
            - self.stt_inr_per_min * overrun / 60.0
        )

    def _committed_inr(self) -> float:
        """Spent or promised, other than on STT."""
        tts_chars = max(self._tts_chars, self._measured_tts_chars) + self._reserved_chars
        return self.tts_inr_per_char * tts_chars + self._llm_inr

    def wait_for(self, chars: int, elapsed_seconds: float, overdraft: bool = False) -> float:
        """Seconds until ``chars`` more speech, and the next request, fit.

        Zero when they fit now. ``overdraft`` measures against the ceiling
        plus the overdraft, for the opening sentence of a reply.
        """
        needed = (
            self._committed_inr()
            + self.tts_inr_per_char * chars
            + self.llm_margin_inr
        )
        if needed <= self._allowance_inr(elapsed_seconds, overdraft):
            return 0.0
        rate = self._net_rate_per_second(overdraft)
        if rate <= 0:
            return float("inf")
        return max(0.0, needed / rate - elapsed_seconds)

    def reserve(self, chars: int) -> None:
        """Admit ``chars`` of speech ahead of their reaching synthesis."""
        self._reserved_chars += chars

    def utilisation(self, elapsed_seconds: float) -> float:
        """Share of the allowance spent or promised."""
        allowance = self._allowance_inr(elapsed_seconds)
        return self._committed_inr() / allowance if allowance > 0 else 1.0

    def rate_inr_per_min(self, elapsed_seconds: float) -> float:
        """Cost per minute so far, on the same time base as the ceiling."""
        minutes = max(elapsed_seconds, HEAD_START_SECONDS) / 60.0
        stt = self.stt_inr_per_min * max(elapsed_seconds, self._stt_seconds) / 60.0
        return (stt + self._committed_inr()) / minutes

    def steer(self, elapsed_seconds: float) -> bool | None:
        """Whether the agent should be told to be terse.

        True when it should start, False when it may stop, None for no change.
        """
        used = self.utilisation(elapsed_seconds)
        if not self.tightened and used >= self.tighten_at:
            self.tightened = True
            logger.info(
                "rate ceiling: %.0f%% of the allowance used (Rs %.2f/min against "
                "Rs %.2f/min); telling the agent to be brief",
                used * 100,
                self.rate_inr_per_min(elapsed_seconds),
                self.ceiling_inr_per_min,
            )
            return True
        if self.tightened and used <= self.relax_at:
            self.tightened = False
            logger.info("rate ceiling: back down to %.0f%% of the allowance", used * 100)
            return False
        return None


class SentenceGate:
    """Releases one reply to synthesis sentence by sentence, as the ceiling allows.

    Sentences rather than raw tokens, because once the limit binds the reply is
    cut short, and it must be cut where a sentence ends rather than mid-word.
    Synthesis works a sentence at a time anyway, so this adds no latency.

    A sentence that does not fit yet is held for up to :data:`MAX_PAUSE_SECONDS`
    while the allowance grows; one that still does not fit ends the reply.

    The request and the reply's first sentence are measured against the
    ceiling plus its overdraft, so an agent over the rate answers briefly
    rather than not at all.
    """

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
        parts = _SENTENCE_END.split(self._buffer)
        self._buffer = parts.pop()
        while len(self._buffer) > _MAX_PIECE_CHARS:
            cut = self._buffer.rfind(" ", 0, _MAX_PIECE_CHARS)
            if cut <= 0:
                cut = _MAX_PIECE_CHARS
            parts.append(self._buffer[:cut])
            self._buffer = self._buffer[cut:].lstrip()
        # Each keeps a trailing space so the next does not run into it.
        return [p + " " for p in parts if p.strip()]

    def rest(self) -> list[str]:
        """Whatever is left once the reply has finished streaming."""
        rest, self._buffer = self._buffer, ""
        return [rest] if rest.strip() else []

    async def admit(self, sentence: str) -> bool:
        """Whether ``sentence`` may be spoken, pausing briefly if need be."""
        if self.stopped:
            self.dropped_chars += len(sentence)
            return False
        chars = len(sentence)
        if not await self._fits(chars, overdraft=self.released_chars == 0):
            self.stopped = True
            self.dropped_chars += chars
            return False
        self._ceiling.reserve(chars)
        self.released_chars += chars
        return True

    async def may_request(self) -> bool:
        """Whether a model request fits, pausing briefly if need be."""
        return await self._fits(0, overdraft=True)

    async def _fits(self, chars: int, overdraft: bool) -> bool:
        wait = self._ceiling.wait_for(chars, self._elapsed(), overdraft)
        if 0 < wait <= self._max_pause:
            # A little over, so float rounding cannot leave it a hair short.
            await self._sleep(wait + 0.05)
            wait = self._ceiling.wait_for(chars, self._elapsed(), overdraft)
        return wait <= 0
