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
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .budget import PLATFORM_MAX_INR_PER_MIN, PLATFORM_MIN_INR_PER_MIN

# Valid values, read off the plugin's own type aliases so they cannot drift out
# of step with the installed version. A model added by Sarvam becomes valid
# here as soon as the plugin is upgraded, with no edit to this file.
STT_MODELS: tuple[str, ...] = typing.get_args(SarvamSTTModels)
STT_MODES: tuple[str, ...] = typing.get_args(SarvamSTTModes)
LLM_MODELS: tuple[str, ...] = typing.get_args(SarvamLLMModels)
TTS_MODELS: tuple[str, ...] = typing.get_args(SarvamTTSModels)
TTS_LANGUAGES: tuple[str, ...] = typing.get_args(SarvamTTSLanguages)


def _literals(alias: object) -> tuple[str, ...]:
    """Every string in a (possibly nested) union of Literal types."""
    out: list[str] = []
    for arg in typing.get_args(alias):
        if isinstance(arg, str):
            out.append(arg)
        else:
            out.extend(_literals(arg))
    return tuple(dict.fromkeys(out))


# The models LiveKit Inference serves, for failing over to when Sarvam does
# not answer. Read off the SDK's own types, like the Sarvam lists above.
FALLBACK_LLM_MODELS = _literals(InferenceLLMModels)
FALLBACK_STT_MODELS = tuple(m for m in _literals(InferenceSTTModels) if m != "auto")
FALLBACK_TTS_MODELS = _literals(InferenceTTSModels)

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


# E.164: a plus, a country code that does not start with zero, and at most
# fifteen digits in all. The carrier rejects anything else, so a transfer
# target in any other form would save cleanly and fail mid-call.
E164_PATTERN = r"^\+[1-9][0-9]{6,14}$"

MAX_TRANSFER_TARGETS = 10
MAX_ANALYSIS_FIELDS = 20

# What most calls end as, for a business that has not said otherwise. Kept
# short: every label is something the model has to choose between, and a long
# list of near-synonyms makes the choice worse rather than finer.
DEFAULT_DISPOSITIONS = (
    "interested",
    "not_interested",
    "callback_requested",
    "resolved",
    "unresolved",
    "wrong_number",
    "do_not_call",
)

Label = Annotated[str, Field(min_length=1, max_length=40)]


class AnalysisField(BaseModel):
    """One value to pull out of a finished call: a callback time, a budget.

    Single-word keys, for the same reason as :class:`TransferTarget`.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    # Becomes a JSON key in webhooks and the API, so it is an identifier.
    name: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
    type: Literal["string", "number", "boolean", "enum"] = "string"
    # What to look for. The model's only guide, like a tool's description.
    description: Annotated[str, Field(max_length=300)] = ""
    # The allowed values of an enum. An enum with none is read as a string
    # rather than refused, since that rule could not be shared with the
    # control plane's schema validation.
    options: Annotated[list[Label], Field(max_length=20)] = Field(default_factory=list)


class TransferTarget(BaseModel):
    """Somewhere the agent may hand a phone call over to.

    Field names are single words on purpose: the control plane converts only
    top-level keys between camelCase and snake_case, so a nested key that
    needed converting would be read differently on each side.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    # What the model chooses between, so it should read as a destination:
    # "sales", "service desk", "a senior advisor".
    name: Annotated[str, Field(min_length=1, max_length=60)]
    number: Annotated[str, Field(pattern=E164_PATTERN)]
    # When to choose this one. Like a tool's description, this is the only
    # thing telling the model which target fits the caller's request.
    description: Annotated[str, Field(max_length=300)] = ""


MAX_CLOSING_LINES = 12


class ClosingLine(BaseModel):
    """The line that closes a call during some hours of the day.

    Hours are in the agent's timezone, ``start`` inclusive and ``end``
    exclusive. A row whose ``start`` is after its ``end`` runs through
    midnight, and one where they are equal covers the whole day -- so no pair
    of hours is invalid, and there is no cross-field rule for the control
    plane's schema to miss. The first row that matches wins.

    ``{{caller_name}}`` in the text is the name the model heard; missing, it
    renders as nothing.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    start: Annotated[int, Field(ge=0, le=23)]
    end: Annotated[int, Field(ge=0, le=24)]
    text: Annotated[str, Field(min_length=1, max_length=300)]


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
    # Run the model on Sarvam's realtime endpoint, finalising each utterance
    # when the session's VAD hears the caller stop: about a quarter of a second
    # sooner per turn than the streaming endpoint, measured, with the same
    # transcripts on saaras:v4. See realtime_stt.py.
    stt_realtime: bool = True
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
    # A ceiling on cost per minute. Never ends a call: the agent is made terser
    # as the rate nears it, and speech it cannot afford is never synthesised.
    # It cannot be switched off: 0 means the platform ceiling, nothing above
    # that is accepted, and nothing so low the agent could barely speak.
    max_inr_per_min: (
        Literal[0]
        | Annotated[
            float, Field(ge=PLATFORM_MIN_INR_PER_MIN, le=PLATFORM_MAX_INR_PER_MIN)
        ]
    ) = PLATFORM_MAX_INR_PER_MIN
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

    # --- opening line -------------------------------------------------------
    # "instructions": the greeting is an instruction the model follows, which
    # costs a model request of the whole prompt on every call and gives words
    # that differ each time. "verbatim": the greeting is spoken exactly as
    # written, with no model request, and its audio is synthesised once and
    # reused -- the cheapest way to open a call.
    greeting_mode: Literal["instructions", "verbatim"] = "instructions"
    # Said after a verbatim greeting when the call is recorded. Empty uses a
    # default for the voice's language; a language with no default has the
    # model write the notice, so a recorded caller is always told.
    recording_notice: Annotated[str, Field(max_length=300)] = ""

    # A prompt that branches on the hour needs the caller's local time, not the
    # platform's.
    timezone: str = DEFAULT_TIMEZONE

    # --- call control -------------------------------------------------------
    # Lets the agent hang up once the conversation is over, instead of holding
    # the line open until the caller does. On by default: an agent that cannot
    # end a call leaves a caller who said goodbye listening to silence.
    end_call_enabled: bool = True

    # The words a call ends on, by the hour. When set, the worker speaks the
    # matching line itself as the call ends, rather than leaving the model to
    # work out the time of day and choose -- which it gets wrong, and which
    # costs every request the tokens of every option. The prompt should then
    # not carry closing lines of its own. Empty leaves the goodbye to the model.
    closing_lines: Annotated[
        list[ClosingLine], Field(max_length=MAX_CLOSING_LINES)
    ] = Field(default_factory=list)

    # Numbers the agent may transfer a phone call to. Empty means the agent is
    # not offered a transfer at all.
    transfer_targets: Annotated[
        list[TransferTarget], Field(max_length=MAX_TRANSFER_TARGETS)
    ] = Field(default_factory=list)

    # --- answering machines -------------------------------------------------
    # Only applies to outbound calls the worker places itself, where it can
    # listen from the moment the call is answered.
    voicemail_detection: bool = True
    # "hangup" ends the call as soon as a machine answers. "leave_message"
    # speaks `voicemail_message` first, or -- when that is empty -- has the
    # model compose a short message from the agent's own prompt.
    voicemail_action: Literal["hangup", "leave_message"] = "hangup"
    voicemail_message: Annotated[str, Field(max_length=1000)] = ""

    # --- after the call -----------------------------------------------------
    # A summary, a disposition and the fields below, written by the language
    # model once the call has ended. Costs a few thousand tokens a call, which
    # are billed with it.
    analysis_enabled: bool = True
    dispositions: Annotated[list[Label], Field(min_length=1, max_length=20)] = Field(
        default_factory=lambda: list(DEFAULT_DISPOSITIONS)
    )
    analysis_fields: Annotated[
        list[AnalysisField], Field(max_length=MAX_ANALYSIS_FIELDS)
    ] = Field(default_factory=list)
    # What a good call looks like, for scoring each one: "confirmed the
    # appointment time", "did not quote a price". Judged pass or fail with the
    # rest of the analysis.
    qa_criteria: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=200)]], Field(max_length=10)
    ] = Field(default_factory=list)

    # --- silence and the keypad ----------------------------------------------
    # Seconds of silence on both sides before the agent checks the caller is
    # still there.
    silence_timeout: Annotated[float, Field(ge=5.0, le=120.0)] = 15.0
    # How many times it checks before hanging up. 0 never hangs up on silence.
    silence_checks: Annotated[int, Field(ge=0, le=5)] = 2
    # Keys the caller presses reach the agent as "[keypad: 1]".
    dtmf_input: bool = True

    # --- when a provider fails -----------------------------------------------
    # Models on LiveKit Inference to switch to when Sarvam errors or times
    # out. Only usable on LiveKit Cloud, and billed there, not by Sarvam. The
    # voice will change mid-call on a TTS failover: better than silence, not
    # as good as the configured voice.
    fallback_llm: Literal[FALLBACK_LLM_MODELS] | None = None  # type: ignore[valid-type]
    fallback_stt: Literal[FALLBACK_STT_MODELS] | None = None  # type: ignore[valid-type]
    fallback_tts: Literal[FALLBACK_TTS_MODELS] | None = None  # type: ignore[valid-type]
    fallback_tts_voice: Annotated[str, Field(max_length=100)] = ""

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
