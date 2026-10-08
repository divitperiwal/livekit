"""A hard ceiling on what a call costs per minute.

The guarantee: at every moment, spend is at most `ceiling` x max(elapsed, 30 s), except
that each reply's first sentence and the model request behind it may use the ceiling
plus the overdraft, so a turn over the rate is answered briefly instead of with silence.
Because it holds at every moment, it holds whenever the caller hangs up.

Speech-to-text runs on the whole call and cannot be throttled, so it is charged first.
Speech is the lever, pulled before the money is spent: the SentenceGate admits each
sentence only if it fits, so text over the ceiling is never synthesised or billed. A
model request is billed whether or not its reply is spoken, so room for the next one is
always held back.
"""

import logging
from dataclasses import dataclass, field

from automitra_worker.cost.prices import (
    LLM_INR_PER_MTOK,
    STT_INR_PER_MIN,
    TTS_INR_PER_CHAR,
    Usage,
    llm_inr,
)

logger = logging.getLogger("automitra.rate_ceiling")

# The allowance never counts less than this much of the call: the greeting is spoken in
# the first seconds, and 30 s is also the shortest billed call.
HEAD_START_SECONDS = 30.0
OPENING_OVERDRAFT_INR_PER_MIN = 0.5
MIN_LLM_MARGIN_PROMPT_TOKENS = 3000
MIN_LLM_MARGIN_COMPLETION_TOKENS = 150

RATE_INSTRUCTIONS = """You are talking too much. From now on every reply must be a single short \
sentence: the next step, or the one question you need. No preamble, no \
sympathy, no restating what the user said."""


@dataclass
class RateCeiling:
    ceiling_inr_per_min: float
    stt_model: str
    tts_model: str
    llm_model: str
    # Steering switches on and off apart, so it does not flap every turn.
    tighten_at: float = 0.80
    relax_at: float = 0.60
    overdraft_inr_per_min: float = OPENING_OVERDRAFT_INR_PER_MIN

    tightened: bool = field(default=False, init=False)
    _sent_tts_chars: float = field(default=0.0, init=False)
    _admitted_unsent_chars: float = field(default=0.0, init=False)
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
        """Room kept for the next model request. The context only grows, so the next
        request is larger than the largest so far."""
        input_rate, output_rate = LLM_INR_PER_MTOK.get(self.llm_model, (0.0, 0.0))
        floor = (
            input_rate * MIN_LLM_MARGIN_PROMPT_TOKENS
            + output_rate * MIN_LLM_MARGIN_COMPLETION_TOKENS
        ) / 1e6
        return max(floor, self._largest_request_inr * 1.25)

    def validate(self) -> None:
        if self.ceiling_inr_per_min <= self.stt_inr_per_min:
            raise ValueError(
                f"a ceiling of Rs {self.ceiling_inr_per_min:.2f}/min is at or below the "
                f"Rs {self.stt_inr_per_min:.2f}/min that speech-to-text costs on its own"
            )

    # Measurement

    def count_tts(self, chars: int) -> None:
        """Characters on their way into synthesis, counted as they are sent."""
        self._sent_tts_chars += chars
        self._admitted_unsent_chars = max(0.0, self._admitted_unsent_chars - chars)

    def observe(self, usage: Usage) -> None:
        self._measured_tts_chars = float(usage.tts_characters_count)
        self._stt_seconds = float(usage.stt_audio_duration)
        self._llm_inr = llm_inr(
            self.llm_model,
            prompt_tokens=usage.llm_prompt_tokens,
            cached_tokens=usage.llm_prompt_cached_tokens,
            completion_tokens=usage.llm_completion_tokens,
        )

    def observe_request(
        self, prompt_tokens: int, cached_tokens: int, completion_tokens: int
    ) -> None:
        request_inr = llm_inr(
            self.llm_model,
            prompt_tokens=prompt_tokens,
            cached_tokens=cached_tokens,
            completion_tokens=completion_tokens,
        )
        self._largest_request_inr = max(self._largest_request_inr, request_inr)

    def begin_reply(self) -> None:
        """Whatever the last reply admitted either reached synthesis and was counted
        there, or was interrupted first and never billed."""
        self._admitted_unsent_chars = 0.0

    def reserve(self, chars: int) -> None:
        self._admitted_unsent_chars += chars

    # The ceiling

    def wait_for(self, chars: int, elapsed_seconds: float, overdraft: bool = False) -> float:
        """Seconds until `chars` more speech and the next request fit; 0 if they fit now."""
        needed = self._committed_inr() + self.tts_inr_per_char * chars + self.llm_margin_inr
        if needed <= self._allowance_inr(elapsed_seconds, overdraft):
            return 0.0
        rate = self._net_rate_per_second(overdraft)
        if rate <= 0:
            return float("inf")
        return max(0.0, needed / rate - elapsed_seconds)

    def utilisation(self, elapsed_seconds: float) -> float:
        allowance = self._allowance_inr(elapsed_seconds)
        return self._committed_inr() / allowance if allowance > 0 else 1.0

    def rate_inr_per_min(self, elapsed_seconds: float) -> float:
        minutes = max(elapsed_seconds, HEAD_START_SECONDS) / 60.0
        stt_inr = self.stt_inr_per_min * max(elapsed_seconds, self._stt_seconds) / 60.0
        return (stt_inr + self._committed_inr()) / minutes

    def steer(self, elapsed_seconds: float) -> bool | None:
        """True to start telling the agent to be terse, False to stop, None for no change."""
        used = self.utilisation(elapsed_seconds)
        if not self.tightened and used >= self.tighten_at:
            self.tightened = True
            logger.info(
                "rate ceiling: %.0f%% of the allowance used (Rs %.2f/min against Rs %.2f/min); "
                "telling the agent to be brief",
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

    def _net_rate_per_second(self, overdraft: bool) -> float:
        ceiling = self.ceiling_inr_per_min + (self.overdraft_inr_per_min if overdraft else 0.0)
        return (ceiling - self.stt_inr_per_min) / 60.0

    def _allowance_inr(self, elapsed_seconds: float, overdraft: bool = False) -> float:
        """What may be spent other than on STT, now and at every later moment. During the
        head start the allowance is flat while STT accrues, so the binding moment for
        early spend is the end of the head start."""
        seconds = max(elapsed_seconds, HEAD_START_SECONDS)
        stt_overrun_seconds = max(0.0, self._stt_seconds - max(elapsed_seconds, 0.0))
        return (
            self._net_rate_per_second(overdraft) * seconds
            - self.stt_inr_per_min * stt_overrun_seconds / 60.0
        )

    def _committed_inr(self) -> float:
        """Spent or promised, other than on STT."""
        tts_chars = (
            max(self._sent_tts_chars, self._measured_tts_chars) + self._admitted_unsent_chars
        )
        return self.tts_inr_per_char * tts_chars + self._llm_inr
