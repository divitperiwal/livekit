"""The validated shape of an agent's configuration.

This is the single source of truth for what a valid agent configuration is. It
is used three ways:

- the worker validates a configuration when it loads one, from a database
  record or from the environment,
- the control plane validates one when a customer saves it, against a JSON
  Schema generated from this model,
- ``scripts/export_schema.py`` writes that schema out, and a test fails if the
  committed copy has drifted.

Keeping one model is what stops the dashboard and the worker disagreeing about
what a valid agent is. The alternative -- writing the rules twice, once in
Python and once in TypeScript -- means they agree on the day they are written
and quietly diverge afterwards, and the symptom is a configuration that saves
cleanly and then fails at three in the morning on a live call.

The model validates *values*, not prose: it knows that ``bulbul:v3`` does not
accept the speaker ``anushka``, because that comes from the Sarvam plugin's own
tables. It does not know whether a prompt is any good.
"""

from __future__ import annotations

import typing
from typing import Annotated, Literal

from livekit.plugins.sarvam.llm import SarvamLLMModels
from livekit.plugins.sarvam.stt import SarvamSTTModels, SarvamSTTModes
from livekit.plugins.sarvam.tts import (
    MODEL_SPEAKER_COMPATIBILITY,
    SarvamTTSLanguages,
    SarvamTTSModels,
)
from pydantic import BaseModel, ConfigDict, Field, model_validator

# Valid values, read off the plugin's own type aliases so they cannot drift out
# of step with the installed version. A model added by Sarvam becomes valid
# here as soon as the plugin is upgraded, with no edit to this file.
STT_MODELS: tuple[str, ...] = typing.get_args(SarvamSTTModels)
STT_MODES: tuple[str, ...] = typing.get_args(SarvamSTTModes)
LLM_MODELS: tuple[str, ...] = typing.get_args(SarvamLLMModels)
TTS_MODELS: tuple[str, ...] = typing.get_args(SarvamTTSModels)
TTS_LANGUAGES: tuple[str, ...] = typing.get_args(SarvamTTSLanguages)

# The semantic turn detector classifies the audio in the trailing silence, so
# the VAD must hold at least this much before reporting end of speech.
MIN_SILENCE_FOR_TURN_DETECTOR = 0.25

# The dealership this project started with runs on India time, and it remains
# the sensible default for an Indic-first platform -- but it is a default, not
# a law. A customer elsewhere gets their own.
DEFAULT_TIMEZONE = "Asia/Kolkata"


def tts_speakers(model: str) -> tuple[str, ...]:
    """The voices a given TTS model accepts.

    Voices are per-model: the bulbul:v2 roster was replaced wholesale in v3, so
    a speaker is only valid against the model it ships with.
    """
    return tuple(MODEL_SPEAKER_COMPATIBILITY[model]["all"])


def default_speaker(model: str) -> str:
    """A voice known to exist on the given model.

    A fixed default would be rejected on half of them.
    """
    return "anushka" if model == "bulbul:v2" else "ritu"


class AgentConfigModel(BaseModel):
    """An agent's configuration, validated.

    Field names are the storage names, in snake_case. The control plane stores
    them camelCased in JSON, and converts at the boundary.
    """

    # `strict` so that a stored 1 is not quietly read as True, and "0.5" not as
    # 0.5. The control plane validates the same JSON against a schema that does
    # not coerce, and the two must reach the same verdict -- a value accepted
    # in the dashboard and rejected at call time is the failure this model
    # exists to prevent.
    #
    # The environment path converts before validating, since a variable is
    # always a string and there is nothing to be strict about.
    model_config = ConfigDict(extra="forbid", strict=True)

    # --- speech to text -----------------------------------------------------
    stt_model: Literal[STT_MODELS] = "saaras:v4"  # type: ignore[valid-type]
    # "codemix" keeps English and Hindi mixed as spoken, which is how people
    # actually talk, instead of forcing the sentence into one script.
    stt_mode: Literal[STT_MODES] = "codemix"  # type: ignore[valid-type]
    # Not constrained to a list: Sarvam accepts a wider set of source-language
    # hints than it exposes as a type, including "unknown" to auto-detect.
    stt_language: str = "hi-IN"

    # --- language model -----------------------------------------------------
    # sarvam-105b-conversations is tuned for multi-turn dialogue and is the
    # model generally available; the others are gated behind beta access and
    # return 400 without it.
    llm_model: Literal[LLM_MODELS] = "sarvam-105b-conversations"  # type: ignore[valid-type]
    llm_temperature: Annotated[float, Field(ge=0.0, le=2.0)] | None = None
    # Caps the length of any single reply, which caps TTS -- the largest line
    # item. Unset leaves replies unbounded.
    max_response_tokens: Annotated[int, Field(gt=0)] | None = None

    # --- text to speech -----------------------------------------------------
    tts_model: Literal[TTS_MODELS] = "bulbul:v3"  # type: ignore[valid-type]
    tts_language: Literal[TTS_LANGUAGES] = "hi-IN"  # type: ignore[valid-type]
    # Validated against tts_model below, since the roster is per model.
    tts_speaker: str = "ritu"
    tts_pace: Annotated[float, Field(gt=0.0, le=3.0)] = 1.0

    # --- cost ceilings ------------------------------------------------------
    # A hard limit on what one call may cost, in rupees. 0 disables it.
    budget_inr: Annotated[float, Field(ge=0.0)] = 0.0
    # A ceiling on cost per minute. Never ends a call -- only makes the agent
    # terser until the rate comes back down. 0 disables it.
    max_inr_per_min: Annotated[float, Field(ge=0.0)] = 0.0
    budget_warn_at: Annotated[float, Field(gt=0.0, lt=1.0)] = 0.70
    budget_wrap_at: Annotated[float, Field(gt=0.0, lt=1.0)] = 0.90
    budget_farewell: str = (
        "Thank the user warmly, tell them the call has to end now, and invite "
        "them to call back if they need anything more."
    )

    # --- turn taking --------------------------------------------------------
    use_turn_detector: bool = True
    vad_min_silence: Annotated[float, Field(ge=0.0)] = 0.25
    vad_min_speech: Annotated[float, Field(ge=0.0)] = 0.05
    vad_activation_threshold: Annotated[float, Field(gt=0.0, lt=1.0)] = 0.5
    vad_prefix_padding: Annotated[float, Field(ge=0.0)] = 0.5
    # Left unset, these adapt to whether semantic detection is on. See
    # ``resolved_endpointing``.
    endpointing_min_delay: Annotated[float, Field(ge=0.0)] | None = None
    endpointing_max_delay: Annotated[float, Field(ge=0.0)] | None = None

    # --- prompt -------------------------------------------------------------
    # Whether the shared voice rules are prepended to the agent's own prompt.
    # "verbatim" is for a complete call script that states its own rules:
    # prepending to such a prompt contradicts it, since the shared rules open
    # with "You are a voice assistant" and tell the model to mirror the
    # caller's language, which an agent playing a named human must not do.
    prompt_mode: Literal["prepend_base_rules", "verbatim"] = "prepend_base_rules"

    # A prompt that branches on the hour needs the caller's local time, not the
    # platform's.
    timezone: str = DEFAULT_TIMEZONE

    # --- cross-field rules --------------------------------------------------

    @model_validator(mode="after")
    def _speaker_exists_on_model(self) -> AgentConfigModel:
        valid = tts_speakers(self.tts_model)
        if self.tts_speaker not in valid:
            raise ValueError(
                f"tts_speaker={self.tts_speaker!r} is not a voice on "
                f"{self.tts_model}. Choose one of: {', '.join(valid)}."
            )
        return self

    @model_validator(mode="after")
    def _turn_detector_has_enough_silence(self) -> AgentConfigModel:
        if self.use_turn_detector and self.vad_min_silence < MIN_SILENCE_FOR_TURN_DETECTOR:
            raise ValueError(
                f"vad_min_silence must be at least {MIN_SILENCE_FOR_TURN_DETECTOR} "
                f"when use_turn_detector is on (got {self.vad_min_silence}). The "
                "semantic turn detector needs that much trailing silence to "
                "classify the turn."
            )
        return self

    @model_validator(mode="after")
    def _budget_stages_are_ordered(self) -> AgentConfigModel:
        # Only meaningful with a ceiling: with none, the fractions are unused.
        if self.budget_inr > 0 and not self.budget_warn_at <= self.budget_wrap_at:
            raise ValueError(
                "budget_warn_at must not exceed budget_wrap_at (got "
                f"warn={self.budget_warn_at}, wrap={self.budget_wrap_at}). They "
                "are fractions of budget_inr, and a call cannot be told to wrap "
                "up before it is warned."
            )
        return self

    @model_validator(mode="after")
    def _endpointing_window_is_ordered(self) -> AgentConfigModel:
        lo, hi = self.resolved_endpointing()
        if lo > hi:
            raise ValueError(
                f"endpointing_min_delay ({lo}) must not exceed "
                f"endpointing_max_delay ({hi})."
            )
        return self

    @model_validator(mode="after")
    def _timezone_is_real(self) -> AgentConfigModel:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(
                f"timezone={self.timezone!r} is not a known IANA zone, such as "
                "Asia/Kolkata or America/New_York."
            ) from exc
        return self

    def resolved_endpointing(self) -> tuple[float, float]:
        """The endpointing window, filling in defaults that depend on the mode.

        With semantic detection the model gives a confident end-of-turn signal,
        so the session can commit sooner than with VAD silence alone.
        """
        lo = self.endpointing_min_delay
        hi = self.endpointing_max_delay
        if lo is None:
            lo = 0.3 if self.use_turn_detector else 0.5
        if hi is None:
            hi = 2.5 if self.use_turn_detector else 3.0
        return lo, hi
