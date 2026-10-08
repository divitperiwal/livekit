from dataclasses import dataclass

from livekit.agents import metrics

MODELS = {
    "stt_model": "saaras:v4",
    "tts_model": "bulbul:v3",
    "llm_model": "sarvam-105b-conversations",
}


@dataclass
class FakeUsage:
    stt_audio_duration: float = 0.0
    tts_characters_count: int = 0
    llm_prompt_tokens: int = 0
    llm_prompt_cached_tokens: int = 0
    llm_completion_tokens: int = 0


def tts_spend(inr: float) -> FakeUsage:
    """Usage costing just under `inr`, all of it speech at Rs 0.003 a character."""
    return FakeUsage(tts_characters_count=int(inr / 0.003))


class Clock:
    """Wall clock for a simulated call; sleeping advances it."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


def llm_metric(
    prompt_tokens: int, completion_tokens: int, cached_tokens: int = 0
) -> metrics.LLMMetrics:
    return metrics.LLMMetrics(
        label="llm",
        request_id="r",
        timestamp=0.0,
        duration=1.0,
        ttft=0.5,
        cancelled=False,
        completion_tokens=completion_tokens,
        prompt_tokens=prompt_tokens,
        prompt_cached_tokens=cached_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        tokens_per_second=50.0,
    )


def tts_metric(characters: int) -> metrics.TTSMetrics:
    return metrics.TTSMetrics(
        label="tts",
        request_id="r",
        timestamp=0.0,
        ttfb=0.2,
        duration=1.0,
        audio_duration=1.0,
        cancelled=False,
        characters_count=characters,
        streamed=True,
    )


def stt_metric(seconds: float) -> metrics.STTMetrics:
    return metrics.STTMetrics(
        label="stt",
        request_id="r",
        timestamp=0.0,
        duration=0.1,
        audio_duration=seconds,
        streamed=True,
    )
