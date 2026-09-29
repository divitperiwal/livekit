"""The live stats a developer sees during a test call."""

from __future__ import annotations

import json
from dataclasses import dataclass

from livekit import rtc
from livekit.agents import metrics

from automitra_worker.audio_input import is_phone
from automitra_worker.budget import RateCeiling
from automitra_worker.live_stats import RECENT, LiveStats


@dataclass
class FakeSummary:
    stt_audio_duration: float = 0.0
    tts_characters_count: int = 0
    llm_prompt_tokens: int = 0
    llm_prompt_cached_tokens: int = 0
    llm_completion_tokens: int = 0


MODELS = {"stt_model": "saaras:v4", "tts_model": "bulbul:v3", "llm_model": "sarvam-105b-conversations"}


def stats() -> LiveStats:
    return LiveStats(**MODELS, tts_speaker="aditya", stt_language="hi-IN")  # type: ignore[arg-type]


def ceiling() -> RateCeiling:
    return RateCeiling(ceiling_inr_per_min=2.5, **MODELS)  # type: ignore[arg-type]


def eou(speech_id: str, delay: float) -> metrics.EOUMetrics:
    return metrics.EOUMetrics(
        timestamp=0, end_of_utterance_delay=delay, transcription_delay=0.1,
        on_user_turn_completed_delay=0, speech_id=speech_id,
    )


def llm(speech_id: str, ttft: float, prompt: int = 2500, cancelled: bool = False) -> metrics.LLMMetrics:
    return metrics.LLMMetrics(
        label="llm", request_id="r", timestamp=0, duration=1, ttft=ttft, cancelled=cancelled,
        completion_tokens=20, prompt_tokens=prompt, prompt_cached_tokens=0, total_tokens=prompt + 20,
        tokens_per_second=20, speech_id=speech_id,
    )


def tts(speech_id: str, ttfb: float) -> metrics.TTSMetrics:
    return metrics.TTSMetrics(
        label="tts", request_id="r", timestamp=0, ttfb=ttfb, duration=1, audio_duration=2,
        cancelled=False, characters_count=40, streamed=True, speech_id=speech_id,
    )


def test_a_turn_is_split_into_its_three_waits_and_totalled() -> None:
    s = stats()
    s.on_metrics(eou("a", 0.4), at=5)
    s.on_metrics(llm("a", 0.3, prompt=2600), at=5.4)
    s.on_metrics(tts("a", 0.25), at=5.7)
    [turn] = s.recent_turns()
    assert turn["eou"] == 0.4 and turn["llm"] == 0.3 and turn["tts"] == 0.25
    assert turn["total"] == 0.95
    assert turn["promptTokens"] == 2600
    assert s.llm_requests == 1 and s.last_prompt_tokens == 2600


def test_a_turn_still_in_progress_has_no_total() -> None:
    s = stats()
    s.on_metrics(eou("a", 0.4), at=5)
    assert "total" not in s.recent_turns()[0]


def test_a_cancelled_request_is_not_counted() -> None:
    s = stats()
    s.on_metrics(llm("a", 0.3, cancelled=True), at=1)
    assert s.llm_requests == 0


def test_only_the_most_recent_turns_are_kept() -> None:
    s = stats()
    for i in range(RECENT + 4):
        s.on_metrics(eou(f"t{i}", 0.1), at=i)
    turns = s.recent_turns()
    assert len(turns) == RECENT
    assert turns[-1]["at"] == RECENT + 3


def test_the_snapshot_carries_cost_and_the_ceiling_and_is_json() -> None:
    s = stats()
    s.on_transcript("महुआ का रेट क्या है", "hi-IN", at=3)
    s.on_tool("search_knowledge", '{"query": "mahua महुआ"}', "Reference passages...", at=4)
    c = ceiling()
    c.skipped_requests = 1
    snap = s.snapshot(40, FakeSummary(stt_audio_duration=40, tts_characters_count=100), c)
    assert snap["cost"]["stt"] == round(0.5 * 40 / 60, 4)
    assert snap["cost"]["tts"] == 0.3
    assert snap["ceiling"]["limitInrPerMin"] == 2.5
    assert snap["ceiling"]["skippedRequests"] == 1
    assert snap["heard"][0]["text"] == "महुआ का रेट क्या है"
    assert snap["tools"][0]["name"] == "search_knowledge"
    assert snap["turns"]["user"] == 1
    json.dumps(snap, ensure_ascii=False)


@dataclass
class FakeParticipant:
    kind: int


def test_a_phone_caller_is_told_apart_from_a_browser() -> None:
    assert is_phone(FakeParticipant(rtc.ParticipantKind.PARTICIPANT_KIND_SIP))  # type: ignore[arg-type]
    assert not is_phone(FakeParticipant(rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD))  # type: ignore[arg-type]
