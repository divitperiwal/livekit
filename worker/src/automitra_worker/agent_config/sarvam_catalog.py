"""Valid model, mode, language and voice values, read from the plugins' own type tables.

Upgrading livekit-plugins-sarvam or livekit-agents updates these, and with them the
exported schema.
"""

import typing

from livekit.agents.inference.llm import LLMModels as InferenceLLMModels
from livekit.agents.inference.stt import STTModels as InferenceSTTModels
from livekit.agents.inference.tts import TTSModels as InferenceTTSModels
from livekit.plugins.sarvam.llm import SarvamLLMModels
from livekit.plugins.sarvam.stt import SarvamSTTModels, SarvamSTTModes
from livekit.plugins.sarvam.tts import (
    MODEL_SPEAKER_COMPATIBILITY,
    SarvamTTSLanguages,
    SarvamTTSModels,
)


def _every_literal_in(alias: object) -> tuple[str, ...]:
    values: list[str] = []
    for argument in typing.get_args(alias):
        if isinstance(argument, str):
            values.append(argument)
        else:
            values.extend(_every_literal_in(argument))
    return tuple(dict.fromkeys(values))


STT_MODELS = typing.get_args(SarvamSTTModels)
STT_MODES = typing.get_args(SarvamSTTModes)
LLM_MODELS = typing.get_args(SarvamLLMModels)
TTS_MODELS = typing.get_args(SarvamTTSModels)
TTS_LANGUAGES = typing.get_args(SarvamTTSLanguages)

TTS_SPEAKERS_BY_MODEL: dict[str, tuple[str, ...]] = {
    model: tuple(MODEL_SPEAKER_COMPATIBILITY[model]["all"]) for model in TTS_MODELS
}

# Hindi verbs agree with the speaker's gender, so the prompt must say which voice speaks.
TTS_SPEAKER_GENDERS: dict[str, dict[str, str]] = {
    model: {
        speaker: gender
        for gender in ("female", "male")
        for speaker in MODEL_SPEAKER_COMPATIBILITY[model][gender]
    }
    for model in TTS_MODELS
}

# The plugin raises mid-call outside this range, so a config must not get there.
TTS_PACE_MIN = 0.3
TTS_PACE_MAX = 3.0

FALLBACK_LLM_MODELS = _every_literal_in(InferenceLLMModels)
FALLBACK_STT_MODELS = tuple(
    model for model in _every_literal_in(InferenceSTTModels) if model != "auto"
)
FALLBACK_TTS_MODELS = _every_literal_in(InferenceTTSModels)
