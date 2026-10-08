"""Sarvam list prices in INR, and what measured usage costs at them.

Sarvam bills in rupees, so there is no exchange rate anywhere. Rates are a snapshot of
https://docs.sarvam.ai/api-reference-docs/pricing: the worker uses them to enforce
ceilings and to log an estimate. What a customer is charged is priced by the API.
"""

from dataclasses import dataclass
from typing import Protocol

# Rs 30 per hour of audio, billed per second. The realtime endpoint is billed under the
# model it runs; Sarvam does not list it separately.
STT_INR_PER_MIN: dict[str, float] = {"saaras:v4": 30.0 / 60, "saaras:v3": 30.0 / 60}

# Rs 30 per 10,000 characters.
TTS_INR_PER_CHAR: dict[str, float] = {
    "bulbul:v3": 30.0 / 10_000,
    "bulbul:v3-beta": 30.0 / 10_000,
    "bulbul:v2": 30.0 / 10_000,
}

# Rs per million tokens, (input, output).
LLM_INR_PER_MTOK: dict[str, tuple[float, float]] = {
    "sarvam-105b": (29.28, 73.2),
    "sarvam-105b-conversations": (29.28, 73.2),
    "gemma4": (29.28, 73.2),
    "glm5.2": (29.28, 73.2),
}

# Cached input is billed at a discount. Sarvam's API currently reports no cached tokens,
# so in practice all input is costed at the full rate: an overestimate, never under.
LLM_INR_CACHED_PER_MTOK: dict[str, float] = {
    "sarvam-105b": 10.98,
    "sarvam-105b-conversations": 10.98,
    "gemma4": 10.98,
    "glm5.2": 10.98,
}


class Usage(Protocol):
    stt_audio_duration: float
    tts_characters_count: int
    llm_prompt_tokens: int
    llm_prompt_cached_tokens: int
    llm_completion_tokens: int


@dataclass(frozen=True)
class CostBreakdown:
    """Per minute from `estimate`; whole-call totals from `usage_cost`."""

    stt_inr: float
    tts_inr: float
    llm_inr: float

    @property
    def total_inr(self) -> float:
        return self.stt_inr + self.tts_inr + self.llm_inr


def llm_inr(
    llm_model: str, *, prompt_tokens: float, cached_tokens: float, completion_tokens: float
) -> float:
    """Cached tokens are a subset of prompt tokens, not an addition to them."""
    input_rate, output_rate = LLM_INR_PER_MTOK.get(llm_model, (0.0, 0.0))
    cached_rate = LLM_INR_CACHED_PER_MTOK.get(llm_model, input_rate)
    fresh_tokens = max(0.0, prompt_tokens - cached_tokens)
    cached_within_prompt = min(cached_tokens, prompt_tokens)
    return (
        input_rate * fresh_tokens
        + cached_rate * cached_within_prompt
        + output_rate * completion_tokens
    ) / 1e6


def usage_cost(usage: Usage, *, stt_model: str, tts_model: str, llm_model: str) -> CostBreakdown:
    """Never raises: this runs on every metrics event of a live call, so an unpriced
    model costs nothing here rather than ending the call. Use `check_priced` where an
    unpriced model must be loud."""
    return CostBreakdown(
        stt_inr=STT_INR_PER_MIN.get(stt_model, 0.0) * usage.stt_audio_duration / 60.0,
        tts_inr=TTS_INR_PER_CHAR.get(tts_model, 0.0) * usage.tts_characters_count,
        llm_inr=llm_inr(
            llm_model,
            prompt_tokens=usage.llm_prompt_tokens,
            cached_tokens=usage.llm_prompt_cached_tokens,
            completion_tokens=usage.llm_completion_tokens,
        ),
    )


def check_priced(*, stt_model: str, tts_model: str, llm_model: str) -> None:
    """Raise KeyError for a model with no rate on file, rather than guessing a price."""
    for kind, model, table in (
        ("STT", stt_model, STT_INR_PER_MIN),
        ("TTS", tts_model, TTS_INR_PER_CHAR),
        ("LLM", llm_model, LLM_INR_PER_MTOK),
    ):
        if model not in table:
            raise KeyError(
                f"No {kind} rate on file for {model!r}. Known: {', '.join(sorted(table))}. "
                "Add it to cost/prices.py, or check https://docs.sarvam.ai/api-reference-docs/pricing"
            )
