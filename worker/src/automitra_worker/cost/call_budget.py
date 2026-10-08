"""A ceiling on what one call may cost, ended in stages rather than cut off.

    warn   the agent is told to be brief and wind down
    wrap   the agent says goodbye and the call ends gracefully
    hard   the session closes at once; a backstop that should not fire

Bookkeeping only: it decides when a stage is reached; the entrypoint acts on it.
"""

import logging
from dataclasses import dataclass, field
from enum import IntEnum

from automitra_worker.cost.prices import STT_INR_PER_MIN, TTS_INR_PER_CHAR, Usage, usage_cost

logger = logging.getLogger("automitra.call_budget")

# Worst case: the agent talking non-stop at ~900 characters a minute.
MAX_TTS_CHARS_PER_MIN = 900.0
FAREWELL_CHARS = 160.0
# Usage arrives per turn, so the wrap stage must trip a whole turn's spend before the
# limit, or a single turn can carry the call from under wrap straight past hard.
TYPICAL_TURN_CHARS = 400.0

WARN_INSTRUCTIONS = """URGENT -- the call is nearly out of time. From now on: keep every reply to one \
short sentence. Do not start new topics, do not offer further help, and do not \
ask follow-up questions unless you need one detail to finish what the user \
already asked. Bring the conversation to a natural close."""


class Stage(IntEnum):
    """Ordered, and only ever moves up."""

    OK = 0
    WARN = 1
    WRAP = 2
    HARD = 3


@dataclass
class CallBudget:
    """`limit_inr` of 0 or below switches the budget off."""

    limit_inr: float
    stt_model: str
    tts_model: str
    llm_model: str
    warn_at: float = 0.70
    wrap_at: float = 0.90

    spent_inr: float = field(default=0.0, init=False)
    stage: Stage = field(default=Stage.OK, init=False)

    @property
    def enabled(self) -> bool:
        return self.limit_inr > 0

    @property
    def reserve_inr(self) -> float:
        """Kept in hand to say goodbye, plus one turn that may already be in flight."""
        return TTS_INR_PER_CHAR.get(self.tts_model, 0.0) * (FAREWELL_CHARS + TYPICAL_TURN_CHARS)

    @property
    def remaining_inr(self) -> float:
        return max(0.0, self.limit_inr - self.spent_inr)

    @property
    def fraction_used(self) -> float:
        return self.spent_inr / self.limit_inr if self.enabled else 0.0

    def validate(self) -> None:
        """Reject, before answering, a budget that would wrap within a turn or two."""
        if not self.enabled:
            return
        floor = self.reserve_inr * 2
        if self.limit_inr < floor:
            raise ValueError(
                f"a call budget of Rs {self.limit_inr:.2f} is too small to hold a conversation: "
                f"Rs {self.reserve_inr:.2f} is reserved to end the call gracefully. "
                f"Use at least Rs {floor:.2f}, or 0 to switch the budget off."
            )

    def implied_minutes(self) -> float:
        """The shortest call this budget affords, with the agent talking non-stop."""
        per_minute = (
            STT_INR_PER_MIN.get(self.stt_model, 0.0)
            + TTS_INR_PER_CHAR.get(self.tts_model, 0.0) * MAX_TTS_CHARS_PER_MIN
        )
        return self.limit_inr / per_minute if per_minute else float("inf")

    def update(self, usage: Usage) -> Stage:
        if not self.enabled:
            return Stage.OK
        self.spent_inr = usage_cost(
            usage, stt_model=self.stt_model, tts_model=self.tts_model, llm_model=self.llm_model
        ).total_inr

        # On a small budget the reserve binds before the wrap fraction does.
        wrap_threshold = min(self.wrap_at * self.limit_inr, self.limit_inr - self.reserve_inr)
        if self.spent_inr >= self.limit_inr:
            reached = Stage.HARD
        elif self.spent_inr >= wrap_threshold:
            reached = Stage.WRAP
        elif self.fraction_used >= self.warn_at:
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
                self.fraction_used * 100,
            )
        return self.stage
