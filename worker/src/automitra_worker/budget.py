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

import logging
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


# Appended to the agent's instructions when the warn stage trips. The agent
# keeps its persona but is told the call is nearly over, so it stops opening
# new threads of conversation.
WARN_INSTRUCTIONS = """

URGENT -- the call is nearly out of time. From now on: keep every reply to one \
short sentence. Do not start new topics, do not offer further help, and do not \
ask follow-up questions unless you need one detail to finish what the user \
already asked. Bring the conversation to a natural close."""


# Appended when the call is running over its per-minute rate. Unlike the budget
# stages this does not end the call -- it makes the agent cheaper so the rate
# comes back down.
RATE_INSTRUCTIONS = """

You are talking too much. From now on every reply must be a single short \
sentence: the next step, or the one question you need. No preamble, no \
sympathy, no restating what the user said."""


@dataclass
class RateGuard:
    """Keeps the cost per minute under a ceiling while the call runs.

    The per-call budget bounds the total; this bounds the *rate*, which is what
    a per-minute price depends on. The only lever is how much the agent says,
    so when the rate drifts over the ceiling the agent is told to be terser.

    STT is a fixed floor (billed on call duration whatever happens), so a
    ceiling below that is impossible and is rejected.
    """

    ceiling_inr_per_min: float
    stt_model: str
    tts_model: str
    llm_model: str

    # Trip slightly under the ceiling: by the time the rate reaches it, the
    # spend has already happened.
    trip_at: float = 0.90

    rate_inr_per_min: float = field(default=0.0, init=False)
    tightened: bool = field(default=False, init=False)

    @property
    def enabled(self) -> bool:
        return self.ceiling_inr_per_min > 0

    @property
    def floor_inr_per_min(self) -> float:
        """Cost per minute with the agent completely silent: STT only."""
        return STT_INR_PER_MIN.get(self.stt_model, 0.0)

    def validate(self) -> None:
        if not self.enabled:
            return
        floor = self.floor_inr_per_min
        if self.ceiling_inr_per_min <= floor:
            raise ValueError(
                f"MAX_INR_PER_MIN={self.ceiling_inr_per_min:.2f} is at or below "
                f"the Rs {floor:.2f}/min that speech-to-text costs on its own, so "
                "no amount of brevity could reach it. Use a higher ceiling, or 0 "
                "to disable the guard."
            )

    def update(self, summary: object, elapsed_seconds: float) -> bool:
        """Recompute the rate. Returns True the first time it trips.

        ``elapsed_seconds`` is wall clock, not billed audio: the rate a
        per-minute price is quoted against is cost per minute of call.
        """
        if not self.enabled or self.tightened or elapsed_seconds <= 0:
            return False

        spent = _cost_so_far(
            summary,
            stt_model=self.stt_model,
            tts_model=self.tts_model,
            llm_model=self.llm_model,
        )
        self.rate_inr_per_min = spent / (elapsed_seconds / 60.0)

        if self.rate_inr_per_min >= self.ceiling_inr_per_min * self.trip_at:
            self.tightened = True
            logger.info(
                "rate guard tripped: Rs %.2f/min against a Rs %.2f/min ceiling",
                self.rate_inr_per_min,
                self.ceiling_inr_per_min,
            )
            return True
        return False
