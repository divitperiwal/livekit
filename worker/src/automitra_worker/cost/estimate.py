"""Per-minute cost of a configuration before any call is made, for the `costs` command."""

from dataclasses import dataclass

from automitra_worker.cost.prices import (
    LLM_INR_PER_MTOK,
    STT_INR_PER_MIN,
    TTS_INR_PER_CHAR,
    CostBreakdown,
    check_priced,
)


@dataclass(frozen=True)
class CallProfile:
    """The shape of an ordinary turn-taking call. `agent_speaking_fraction` and
    `context_tokens_per_turn` move the answer most."""

    agent_speaking_fraction: float = 0.5
    speaking_chars_per_min: float = 900.0  # ~150 words a minute at ~6 characters a word
    turns_per_min: float = 4.0
    context_tokens_per_turn: float = 1200.0
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


def estimate(
    *, stt_model: str, tts_model: str, llm_model: str, profile: CallProfile | None = None
) -> CostBreakdown:
    """Assumes no cached input, so it errs high: a budgeting figure, not a prediction."""
    profile = profile or CallProfile()
    check_priced(stt_model=stt_model, tts_model=tts_model, llm_model=llm_model)
    input_rate, output_rate = LLM_INR_PER_MTOK[llm_model]
    return CostBreakdown(
        stt_inr=STT_INR_PER_MIN[stt_model],
        tts_inr=TTS_INR_PER_CHAR[tts_model] * profile.tts_chars_per_min,
        llm_inr=(
            input_rate * profile.llm_input_tokens_per_min
            + output_rate * profile.llm_output_tokens_per_min
        )
        / 1e6,
    )


def render_per_minute(breakdown: CostBreakdown, *, stt: str, tts: str, llm: str) -> str:
    total = breakdown.total_inr

    def row(label: str, model: str, inr: float) -> str:
        share = inr / total * 100 if total else 0.0
        return f"  {label:4s} {model:28s} Rs {inr:7.4f}  {share:5.1f}%"

    return "\n".join(
        [
            f"  {'':4s} {'model':28s} {'Rs/min':>10s}  {'share':>6s}",
            row("stt", stt, breakdown.stt_inr),
            row("tts", tts, breakdown.tts_inr),
            row("llm", llm, breakdown.llm_inr),
            "  " + "-" * 56,
            f"  {'':4s} {'TOTAL':28s} Rs {total:7.4f}",
            "",
            f"  per hour of conversation   Rs {total * 60:8.2f}",
            f"  per 1,000 minutes          Rs {total * 1000:8.0f}",
            f"  1,000 min/day for 30 days  Rs {total * 1000 * 30:8,.0f}",
        ]
    )
