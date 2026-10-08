"""The one definition of a valid agent configuration.

Stored and served camelCase (the aliases); used snake_case in the worker. Nested keys are
single words on purpose, so only top-level keys differ between the two.

Every rule that JSON Schema can express lives in the field types, so the API's ajv
validator enforces it too. The few cross-field rules are in `cross_field_rules`, and the
API repeats them by hand.
"""

from typing import Annotated, Literal, Self
from zoneinfo import available_timezones

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from automitra_worker.agent_config.sarvam_catalog import (
    FALLBACK_LLM_MODELS,
    FALLBACK_STT_MODELS,
    FALLBACK_TTS_MODELS,
    LLM_MODELS,
    STT_MODELS,
    STT_MODES,
    TTS_LANGUAGES,
    TTS_MODELS,
    TTS_PACE_MAX,
    TTS_PACE_MIN,
    TTS_SPEAKERS_BY_MODEL,
)

E164_PATTERN = r"^\+[1-9][0-9]{6,14}$"
ANALYSIS_FIELD_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"

DEFAULT_DISPOSITIONS = (
    "interested",
    "not_interested",
    "callback_requested",
    "resolved",
    "unresolved",
    "wrong_number",
    "do_not_call",
)

ENDPOINTING_DELAYS_WITH_TURN_DETECTOR = (0.3, 2.5)
ENDPOINTING_DELAYS_WITHOUT_TURN_DETECTOR = (0.5, 3.0)
MIN_VAD_SILENCE_WITH_TURN_DETECTOR = 0.25
PLATFORM_MIN_INR_PER_MIN = 1.0
PLATFORM_MAX_INR_PER_MIN = 2.5

DEFAULT_BUDGET_FAREWELL = (
    "Thank the user warmly, tell them the call has to end now, and invite them to "
    "call back if they need anything more."
)

Label = Annotated[str, StringConstraints(min_length=1, max_length=40)]
Description = Annotated[str, StringConstraints(max_length=300)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ClosingLine(_StrictModel):
    """Hours in the agent's timezone, start inclusive, end exclusive.

    start after end runs through midnight; start equal to end covers the whole day.
    The first matching line wins.
    """

    start: Annotated[int, Field(ge=0, le=23)]
    end: Annotated[int, Field(ge=0, le=24)]
    text: Annotated[str, StringConstraints(min_length=1, max_length=300)]


class TransferTarget(_StrictModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    number: Annotated[str, StringConstraints(pattern=E164_PATTERN)]
    description: Description = ""


class AnalysisField(_StrictModel):
    """An enum with no options is read as a string rather than refused."""

    name: Annotated[str, StringConstraints(pattern=ANALYSIS_FIELD_NAME_PATTERN)]
    type: Literal["string", "number", "boolean", "enum"] = "string"
    description: Description = ""
    options: Annotated[list[Label], Field(max_length=20)] = []


class AgentConfigModel(_StrictModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        title="AgentConfig",
    )

    # Speech-to-text. The language is a hint: Sarvam accepts more than its type lists,
    # including "unknown" to auto-detect.
    stt_model: Literal[STT_MODELS] = "saaras:v4"
    stt_realtime: bool = True
    stt_mode: Literal[STT_MODES] = "codemix"
    stt_language: str = "hi-IN"

    # LLM. Models other than sarvam-105b-conversations need Sarvam beta access.
    llm_model: Literal[LLM_MODELS] = "sarvam-105b-conversations"
    llm_temperature: Annotated[float, Field(ge=0, le=2)] | None = None
    max_response_tokens: Annotated[int, Field(gt=0)] | None = None

    # Text-to-speech
    tts_model: Literal[TTS_MODELS] = "bulbul:v3"
    tts_language: Literal[TTS_LANGUAGES] = "hi-IN"
    tts_speaker: str = "ritu"
    tts_pace: Annotated[float, Field(ge=TTS_PACE_MIN, le=TTS_PACE_MAX)] = 1.0

    # Cost ceilings. budget_inr 0 is off; max_inr_per_min cannot be switched off,
    # 0 means the platform ceiling.
    budget_inr: Annotated[float, Field(ge=0)] = 0.0
    max_inr_per_min: (
        Literal[0]
        | Annotated[float, Field(ge=PLATFORM_MIN_INR_PER_MIN, le=PLATFORM_MAX_INR_PER_MIN)]
    ) = PLATFORM_MAX_INR_PER_MIN
    budget_warn_at: Annotated[float, Field(gt=0, lt=1)] = 0.70
    budget_wrap_at: Annotated[float, Field(gt=0, lt=1)] = 0.90
    budget_farewell: str = DEFAULT_BUDGET_FAREWELL

    # Turn taking. Unset endpointing delays follow the turn-detector mode.
    use_turn_detector: bool = True
    vad_min_silence: Annotated[float, Field(ge=0)] = MIN_VAD_SILENCE_WITH_TURN_DETECTOR
    vad_min_speech: Annotated[float, Field(ge=0)] = 0.05
    vad_activation_threshold: Annotated[float, Field(gt=0, lt=1)] = 0.5
    vad_prefix_padding: Annotated[float, Field(ge=0)] = 0.5
    endpointing_min_delay: Annotated[float, Field(ge=0)] | None = None
    endpointing_max_delay: Annotated[float, Field(ge=0)] | None = None

    # Prompt and greeting. An empty recording_notice uses the voice language's default.
    prompt_mode: Literal["prepend_base_rules", "verbatim"] = "prepend_base_rules"
    greeting_mode: Literal["instructions", "verbatim"] = "instructions"
    recording_notice: Annotated[str, StringConstraints(max_length=300)] = ""
    timezone: str = "Asia/Kolkata"

    # Call control
    end_call_enabled: bool = True
    closing_lines: Annotated[list[ClosingLine], Field(max_length=12)] = []
    transfer_targets: Annotated[list[TransferTarget], Field(max_length=10)] = []

    # Answering machines, outbound only. An empty voicemail_message has the model
    # compose one.
    voicemail_detection: bool = True
    voicemail_action: Literal["hangup", "leave_message"] = "hangup"
    voicemail_message: Annotated[str, StringConstraints(max_length=1000)] = ""

    # After the call
    analysis_enabled: bool = True
    dispositions: Annotated[list[Label], Field(min_length=1, max_length=20)] = list(
        DEFAULT_DISPOSITIONS
    )
    analysis_fields: Annotated[list[AnalysisField], Field(max_length=20)] = []
    qa_criteria: Annotated[
        list[Annotated[str, StringConstraints(min_length=1, max_length=200)]],
        Field(max_length=10),
    ] = []

    # Silence and keypad
    silence_timeout: Annotated[float, Field(ge=5, le=120)] = 15.0
    silence_checks: Annotated[int, Field(ge=0, le=5)] = 2
    dtmf_input: bool = True

    # Failover to LiveKit Inference when Sarvam errors or times out. Billed by LiveKit.
    fallback_llm: Literal[FALLBACK_LLM_MODELS] | None = None
    fallback_stt: Literal[FALLBACK_STT_MODELS] | None = None
    fallback_tts: Literal[FALLBACK_TTS_MODELS] | None = None
    fallback_tts_voice: Annotated[str, StringConstraints(max_length=100)] = ""

    @classmethod
    def from_stored(cls, stored_config: dict) -> Self:
        """Validate a config in its stored camelCase form, as the API serves it."""
        return cls.model_validate(stored_config, by_alias=True, by_name=False)

    def to_stored(self) -> dict:
        return self.model_dump(mode="json", by_alias=True)

    @property
    def effective_max_inr_per_min(self) -> float:
        return self.max_inr_per_min or PLATFORM_MAX_INR_PER_MIN

    @property
    def effective_endpointing_delays(self) -> tuple[float, float]:
        default_min, default_max = (
            ENDPOINTING_DELAYS_WITH_TURN_DETECTOR
            if self.use_turn_detector
            else ENDPOINTING_DELAYS_WITHOUT_TURN_DETECTOR
        )
        return (
            default_min if self.endpointing_min_delay is None else self.endpointing_min_delay,
            default_max if self.endpointing_max_delay is None else self.endpointing_max_delay,
        )

    @model_validator(mode="after")
    def cross_field_rules(self) -> Self:
        problems = [
            problem
            for problem in (
                self._speaker_problem(),
                self._timezone_problem(),
                self._budget_stage_problem(),
                self._vad_silence_problem(),
                self._endpointing_problem(),
            )
            if problem
        ]
        if problems:
            raise ValueError("; ".join(problems))
        return self

    def _speaker_problem(self) -> str | None:
        speakers = TTS_SPEAKERS_BY_MODEL[self.tts_model]
        if self.tts_speaker not in speakers:
            return f"ttsSpeaker {self.tts_speaker!r} is not a voice of {self.tts_model}"
        return None

    def _timezone_problem(self) -> str | None:
        if self.timezone not in available_timezones():
            return f"timezone {self.timezone!r} is not an IANA time zone"
        return None

    def _budget_stage_problem(self) -> str | None:
        if self.budget_inr > 0 and self.budget_wrap_at < self.budget_warn_at:
            return "budgetWrapAt must be at least budgetWarnAt when a budget is set"
        return None

    def _vad_silence_problem(self) -> str | None:
        if self.use_turn_detector and self.vad_min_silence < MIN_VAD_SILENCE_WITH_TURN_DETECTOR:
            return (
                f"vadMinSilence must be at least {MIN_VAD_SILENCE_WITH_TURN_DETECTOR} "
                "with the turn detector on"
            )
        return None

    def _endpointing_problem(self) -> str | None:
        min_delay, max_delay = self.effective_endpointing_delays
        if min_delay > max_delay:
            return "endpointingMinDelay must not exceed endpointingMaxDelay"
        return None
