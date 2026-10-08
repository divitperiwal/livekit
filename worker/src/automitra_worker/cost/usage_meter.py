"""Running totals of what a call used, collected from the session's metrics events.

Our own rather than LiveKit's `UsageCollector`, which 1.8 deprecates, and limited to the
five figures the call is priced on.
"""

from dataclasses import dataclass

from livekit.agents import metrics


@dataclass
class UsageMeter:
    stt_audio_duration: float = 0.0
    tts_characters_count: int = 0
    llm_prompt_tokens: int = 0
    llm_prompt_cached_tokens: int = 0
    llm_completion_tokens: int = 0

    def collect(self, metric: object) -> None:
        if isinstance(metric, metrics.LLMMetrics):
            self.llm_prompt_tokens += metric.prompt_tokens
            self.llm_prompt_cached_tokens += metric.prompt_cached_tokens
            self.llm_completion_tokens += metric.completion_tokens
        elif isinstance(metric, metrics.TTSMetrics):
            self.tts_characters_count += metric.characters_count
        elif isinstance(metric, metrics.STTMetrics):
            self.stt_audio_duration += metric.audio_duration
