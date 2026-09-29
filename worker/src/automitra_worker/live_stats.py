"""What a developer watching a test call sees while it runs.

The call record says how a call went once it is over. Tuning an agent needs
the same figures during the call, turn by turn: which part of a slow reply was
slow, what the model was sent, what the caller was heard to say, what a tool
was asked, and how close the call is to its cost ceiling -- the ceiling is the
usual reason an agent goes quiet.

This module only keeps the figures; the agent publishes :meth:`snapshot` to
the room on :data:`TOPIC`, where the dashboard's test-call panel reads it. A
phone caller never receives it, since only browser participants are sent it.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

from livekit.agents import metrics

from .budget import RateCeiling
from .costs import actual_cost
from .latency import LatencyTracker

TOPIC = "automitra.stats"

# Enough history to read the last few turns without the message growing.
RECENT = 6


@dataclass
class LiveStats:
    stt_model: str
    llm_model: str
    tts_model: str
    tts_speaker: str
    stt_language: str

    agent_state: str = "initializing"
    user_state: str = "listening"
    user_turns: int = 0
    interruptions: int = 0
    llm_requests: int = 0
    last_prompt_tokens: int = 0
    last_completion_tokens: int = 0
    heard: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=RECENT))
    tools: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=RECENT))
    latency: LatencyTracker = field(default_factory=LatencyTracker)
    # speech id -> component -> seconds, for the most recent turns only.
    _turns: dict[str, dict[str, float]] = field(default_factory=dict)
    _order: deque[str] = field(default_factory=lambda: deque(maxlen=RECENT))

    def on_metrics(self, metric: Any, at: float) -> None:
        self.latency.collect(metric)
        if isinstance(metric, metrics.LLMMetrics) and not metric.cancelled:
            self.llm_requests += 1
            self.last_prompt_tokens = metric.prompt_tokens
            self.last_completion_tokens = metric.completion_tokens
        speech_id = getattr(metric, "speech_id", None)
        if not speech_id:
            return
        if speech_id not in self._turns:
            self._turns[speech_id] = {"at": round(at, 1)}
            self._order.append(speech_id)
            # Keep only the turns still in the window.
            for old in [k for k in self._turns if k not in self._order]:
                del self._turns[old]
        turn = self._turns[speech_id]
        if isinstance(metric, metrics.EOUMetrics):
            turn.setdefault("eou", round(metric.end_of_utterance_delay, 3))
        elif isinstance(metric, metrics.LLMMetrics) and not metric.cancelled:
            turn.setdefault("llm", round(metric.ttft, 3))
            turn.setdefault("promptTokens", metric.prompt_tokens)
        elif isinstance(metric, metrics.TTSMetrics) and not metric.cancelled:
            turn.setdefault("tts", round(metric.ttfb, 3))

    def on_transcript(self, text: str, language: str | None, at: float) -> None:
        """A final transcript of what the caller said."""
        self.user_turns += 1
        self.heard.append({"at": round(at, 1), "text": text, "language": language or ""})

    def on_tool(self, name: str, arguments: str, output: str, at: float) -> None:
        self.tools.append({"at": round(at, 1), "name": name, "args": arguments[:200], "output": output[:200]})

    def recent_turns(self) -> list[dict[str, float]]:
        turns = []
        for speech_id in self._order:
            turn = dict(self._turns.get(speech_id, {}))
            parts = [turn.get(k) for k in ("eou", "llm", "tts")]
            if all(p is not None for p in parts):
                turn["total"] = round(sum(parts), 3)  # type: ignore[arg-type]
            turns.append(turn)
        return turns

    def snapshot(self, elapsed: float, usage: object, ceiling: RateCeiling) -> dict[str, Any]:
        cost = actual_cost(
            usage, stt_model=self.stt_model, tts_model=self.tts_model, llm_model=self.llm_model
        )
        return {
            "t": round(elapsed, 1),
            "models": {
                "stt": self.stt_model,
                "llm": self.llm_model,
                "tts": self.tts_model,
                "speaker": self.tts_speaker,
                "sttLanguage": self.stt_language,
            },
            "state": {"agent": self.agent_state, "user": self.user_state},
            "turns": {
                "user": self.user_turns,
                "interruptions": self.interruptions,
                "recent": self.recent_turns(),
                "summary": self.latency.summary(),
            },
            "llm": {
                "requests": self.llm_requests,
                "lastPromptTokens": self.last_prompt_tokens,
                "lastCompletionTokens": self.last_completion_tokens,
                "promptTokens": int(getattr(usage, "llm_prompt_tokens", 0) or 0),
                "completionTokens": int(getattr(usage, "llm_completion_tokens", 0) or 0),
            },
            "speech": {
                "sttSeconds": round(float(getattr(usage, "stt_audio_duration", 0.0) or 0.0), 1),
                "ttsChars": int(getattr(usage, "tts_characters_count", 0) or 0),
            },
            "cost": {
                "stt": round(cost.stt_inr, 4),
                "tts": round(cost.tts_inr, 4),
                "llm": round(cost.llm_inr, 4),
                "total": round(cost.total_inr, 4),
            },
            "ceiling": {
                "inrPerMin": round(ceiling.rate_inr_per_min(elapsed), 3),
                "limitInrPerMin": ceiling.ceiling_inr_per_min,
                "utilisation": round(ceiling.utilisation(elapsed), 3),
                "tightened": ceiling.tightened,
                "skippedRequests": ceiling.skipped_requests,
                "heldBackChars": ceiling.held_back_chars,
            },
            "heard": list(self.heard),
            "tools": list(self.tools),
        }
