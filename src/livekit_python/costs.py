"""Cost estimation for a voice session.

Sarvam bills natively in Indian Rupees, so every rate here is in INR and there
is no exchange rate anywhere in this module. Rates are Sarvam list prices as
published at https://docs.sarvam.ai/api-reference-docs/pricing. They are a
snapshot and will drift -- treat the output as an estimate for comparing
configurations, not as a bill.
"""

from __future__ import annotations

from dataclasses import dataclass

# --- Rate cards ---------------------------------------------------------
# STT: Rs per minute of audio. Sarvam quotes Rs 30/hour, billed per second.
# Diarisation is a separate, dearer rate; the agent does not use it.
STT_INR_PER_MIN: dict[str, float] = {
    "saaras:v4": 30.0 / 60,
    "saaras:v3": 30.0 / 60,
}

# TTS: Rs per character. Sarvam quotes Rs 30 per 10,000 characters.
TTS_INR_PER_CHAR: dict[str, float] = {
    "bulbul:v3": 30.0 / 10_000,
    "bulbul:v3-beta": 30.0 / 10_000,
    "bulbul:v2": 30.0 / 10_000,
}

# LLM: Rs per million tokens, (input, output).
LLM_INR_PER_MTOK: dict[str, tuple[float, float]] = {
    "sarvam-105b": (29.28, 73.2),
    "sarvam-105b-conversations": (29.28, 73.2),
    "gemma4": (29.28, 73.2),
    "glm5.2": (29.28, 73.2),
}

# Cached input is billed at a discount. ``estimate`` cannot know the hit rate
# ahead of time so it assumes none and errs high; costing from measured usage
# uses the real cached-token count.
LLM_INR_CACHED_PER_MTOK: dict[str, float] = {
    "sarvam-105b": 10.98,
    "sarvam-105b-conversations": 10.98,
    "gemma4": 10.98,
    "glm5.2": 10.98,
}


@dataclass(frozen=True)
class CallProfile:
    """Shape of a typical conversation, used to turn rates into a per-minute cost.

    The defaults describe an ordinary turn-taking call. Measure your own with
    ``AgentSession`` metrics and adjust -- ``agent_speaking_fraction`` and
    ``context_tokens_per_turn`` are the two that move the answer most.
    """

    agent_speaking_fraction: float = 0.5   # share of wall-clock the agent talks
    speaking_chars_per_min: float = 900.0  # ~150 wpm at ~6 chars/word
    turns_per_min: float = 4.0
    context_tokens_per_turn: float = 1200.0  # system prompt + rolling history
    output_tokens_per_turn: float = 60.0

    @property
    def tts_chars_per_min(self) -> float:
        return self.speaking_chars_per_min * self.agent_speaking_fraction

    @property
    def llm_input_tokens_per_min(self) -> float:
        return self.turns_per_min * self.context_tokens_per_turn

    @property
    def llm_output_tokens_per_min(self) -> float:
        return self.turns_per_min * self.output_tokens_per_turn


@dataclass(frozen=True)
class CostBreakdown:
    """Cost split by component, in INR.

    The fields are per-minute for :func:`estimate` and whole-session totals for
    :func:`actual_cost`; ``total_inr`` means whichever of the two produced it.
    """

    stt_inr: float
    tts_inr: float
    llm_inr: float

    @property
    def total_inr(self) -> float:
        return self.stt_inr + self.tts_inr + self.llm_inr

    def render(self, *, stt: str, tts: str, llm: str) -> str:
        total = self.total_inr

        def row(label: str, model: str, inr: float) -> str:
            share = (inr / total * 100) if total else 0.0
            return f"  {label:4s} {model:28s} Rs {inr:7.4f}  {share:5.1f}%"

        return "\n".join([
            f"  {'':4s} {'model':28s} {'Rs/min':>10s}  {'share':>6s}",
            row("stt", stt, self.stt_inr),
            row("tts", tts, self.tts_inr),
            row("llm", llm, self.llm_inr),
            "  " + "-" * 56,
            f"  {'':4s} {'TOTAL':28s} Rs {total:7.4f}",
            "",
            f"  per hour of conversation   Rs {total * 60:8.2f}",
            f"  per 1,000 minutes          Rs {total * 1000:8.0f}",
            f"  1,000 min/day for 30 days  Rs {total * 1000 * 30:8,.0f}",
        ])


def _unknown(kind: str, model: str, known: object) -> str:
    return (
        f"No {kind} rate on file for {model!r}. Known: {', '.join(sorted(known))}. "  # type: ignore[arg-type]
        "Add it to costs.py, or check "
        "https://docs.sarvam.ai/api-reference-docs/pricing"
    )


def _check_models(stt_model: str, tts_model: str, llm_model: str) -> None:
    """Reject a model with no rate on file, rather than guessing a price."""
    if stt_model not in STT_INR_PER_MIN:
        raise KeyError(_unknown("STT", stt_model, STT_INR_PER_MIN))
    if tts_model not in TTS_INR_PER_CHAR:
        raise KeyError(_unknown("TTS", tts_model, TTS_INR_PER_CHAR))
    if llm_model not in LLM_INR_PER_MTOK:
        raise KeyError(_unknown("LLM", llm_model, LLM_INR_PER_MTOK))


def actual_cost(
    summary: object,
    *,
    stt_model: str,
    tts_model: str,
    llm_model: str,
) -> CostBreakdown:
    """Cost of a real session, from a ``metrics.UsageSummary``.

    Unlike :func:`estimate` this uses measured usage -- seconds of audio
    transcribed, characters synthesised, tokens consumed -- so it reflects what
    actually happened rather than an assumed conversation shape. The returned
    figures are totals for the session, not per-minute rates.
    """
    _check_models(stt_model, tts_model, llm_model)

    stt_seconds = float(getattr(summary, "stt_audio_duration", 0.0) or 0.0)
    tts_chars = float(getattr(summary, "tts_characters_count", 0) or 0)
    prompt_tokens = float(getattr(summary, "llm_prompt_tokens", 0) or 0)
    cached_tokens = float(getattr(summary, "llm_prompt_cached_tokens", 0) or 0)
    completion_tokens = float(getattr(summary, "llm_completion_tokens", 0) or 0)

    llm_in_rate, llm_out_rate = LLM_INR_PER_MTOK[llm_model]
    llm_cached_rate = LLM_INR_CACHED_PER_MTOK.get(llm_model, llm_in_rate)

    # Cached tokens are reported as a subset of the prompt total, not as an
    # extra, so charging both in full would double count them.
    fresh_tokens = max(0.0, prompt_tokens - cached_tokens)

    return CostBreakdown(
        stt_inr=STT_INR_PER_MIN[stt_model] * (stt_seconds / 60.0),
        tts_inr=TTS_INR_PER_CHAR[tts_model] * tts_chars,
        llm_inr=(
            llm_in_rate * fresh_tokens
            + llm_cached_rate * cached_tokens
            + llm_out_rate * completion_tokens
        ) / 1e6,
    )


def estimate(
    *,
    stt_model: str,
    tts_model: str,
    llm_model: str,
    profile: CallProfile | None = None,
) -> CostBreakdown:
    """Estimate the per-minute cost of a configuration.

    Raises ``KeyError`` for a model with no rate on file, rather than guessing
    a price and quietly reporting a wrong number.
    """
    profile = profile or CallProfile()
    _check_models(stt_model, tts_model, llm_model)

    llm_in, llm_out = LLM_INR_PER_MTOK[llm_model]

    return CostBreakdown(
        stt_inr=STT_INR_PER_MIN[stt_model],
        tts_inr=TTS_INR_PER_CHAR[tts_model] * profile.tts_chars_per_min,
        llm_inr=(
            llm_in * profile.llm_input_tokens_per_min
            + llm_out * profile.llm_output_tokens_per_min
        ) / 1e6,
    )
