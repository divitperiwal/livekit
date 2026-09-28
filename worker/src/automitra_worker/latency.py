"""How long the caller waits for each reply.

A reply's delay is three waits in a row: deciding the caller has finished
(end of utterance), the language model's first token, and the voice's first
audio. The SDK reports each separately, tagged with the id of the reply they
belong to, so they are joined here into one number per turn -- the silence the
caller actually sat through.

Averages hide the turns that make a call feel broken, so the call record keeps
the median, the 95th percentile and the worst, alongside the components, which
say which part to fix.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from livekit.agents import metrics


def percentile(values: list[float], p: float) -> float:
    """The p-th percentile by linear interpolation; values need not be sorted."""
    ordered = sorted(values)
    if not ordered:
        return 0.0
    rank = (len(ordered) - 1) * p
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


@dataclass
class LatencyTracker:
    # speech id -> component -> seconds. Only the first of each is kept: a
    # reply's LLM or TTS can be reported more than once, and the first is the
    # one the caller waited for.
    _turns: dict[str, dict[str, float]] = field(default_factory=dict)

    def collect(self, metric: Any) -> None:
        speech_id = getattr(metric, "speech_id", None)
        if not speech_id:
            return
        turn = self._turns.setdefault(speech_id, {})
        if isinstance(metric, metrics.EOUMetrics):
            turn.setdefault("eou", metric.end_of_utterance_delay)
        elif isinstance(metric, metrics.LLMMetrics) and not metric.cancelled:
            turn.setdefault("llm", metric.ttft)
        elif isinstance(metric, metrics.TTSMetrics) and not metric.cancelled:
            turn.setdefault("tts", metric.ttfb)

    def summary(self) -> dict[str, Any] | None:
        """Per-call figures in seconds, or None when no turn was measured whole.

        A turn missing a component -- the greeting has no end of utterance, an
        interrupted reply may have no audio -- is not a wait the caller sat
        through, so it is left out rather than counted short.
        """
        complete = [t for t in self._turns.values() if {"eou", "llm", "tts"} <= t.keys()]
        if not complete:
            return None
        totals = [t["eou"] + t["llm"] + t["tts"] for t in complete]
        mean = lambda key: round(sum(t[key] for t in complete) / len(complete), 3)  # noqa: E731
        return {
            "turns": len(complete),
            "p50": round(percentile(totals, 0.5), 3),
            "p95": round(percentile(totals, 0.95), 3),
            "max": round(max(totals), 3),
            "eou": mean("eou"),
            "llm": mean("llm"),
            "tts": mean("tts"),
        }
