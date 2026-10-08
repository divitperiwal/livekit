"""How long the caller waits for each reply.

A reply's delay is three waits in a row: deciding the caller has finished, the LLM's
first token, and the voice's first audio. The SDK reports each tagged with the reply's
speech id, so they are joined here into one number per turn. Averages hide the turns
that make a call feel broken, so the record keeps the median, p95 and worst, plus the
component that dominates, which says what to fix.
"""

from dataclasses import dataclass, field

from livekit.agents import metrics

from automitra_worker.control_plane.contract import LatencySummary

COMPONENTS = ("eou", "llm", "tts")


def percentile(values: list[float], fraction: float) -> float:
    """Linear interpolation; values need not be sorted."""
    ordered = sorted(values)
    if not ordered:
        return 0.0
    rank = (len(ordered) - 1) * fraction
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


@dataclass
class LatencyTracker:
    # speech id -> component -> seconds. Only the first report of each is kept: it is
    # the one the caller waited for.
    _turns: dict[str, dict[str, float]] = field(default_factory=dict)

    def collect(self, metric: object) -> None:
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

    def summary(self) -> LatencySummary | None:
        """None when no turn was measured whole. A turn missing a component (the greeting
        has no end of utterance) is not a wait the caller sat through."""
        complete = [turn for turn in self._turns.values() if set(COMPONENTS) <= turn.keys()]
        if not complete:
            return None
        totals = [sum(turn[component] for component in COMPONENTS) for turn in complete]
        means = {
            component: round(sum(turn[component] for turn in complete) / len(complete), 3)
            for component in COMPONENTS
        }
        return LatencySummary(
            turns=len(complete),
            p50=round(percentile(totals, 0.5), 3),
            p95=round(percentile(totals, 0.95), 3),
            max=round(max(totals), 3),
            dominant=max(means, key=means.__getitem__),
            **means,
        )
