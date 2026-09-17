"""Runtime configuration for the voice agent.

Every knob is an environment variable so the STT, TTS and LLM can be tuned
without touching code. All three components are Sarvam, so a single
``SARVAM_API_KEY`` covers the whole stack and billing is natively in INR.

Model, mode, language and speaker values are validated against the enums the
Sarvam plugin itself exports, so a typo fails at startup with the list of
valid values rather than surfacing as an API error mid-call.
"""

from __future__ import annotations

import os
import typing
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from livekit.plugins.sarvam.llm import SarvamLLMModels
from livekit.plugins.sarvam.stt import SarvamSTTModels, SarvamSTTModes
from livekit.plugins.sarvam.tts import (
    MODEL_SPEAKER_COMPATIBILITY,
    SarvamTTSLanguages,
    SarvamTTSModels,
)

from .personas import DEFAULT_PERSONA, VOICE_BASE_RULES, get_persona

# The semantic turn detector classifies the audio in the trailing silence, so
# the VAD must hold at least this much before reporting end of speech.
MIN_SILENCE_FOR_TURN_DETECTOR = 0.25

# Valid values, read off the plugin's own type aliases so they cannot drift
# out of step with the installed version.
STT_MODELS: tuple[str, ...] = typing.get_args(SarvamSTTModels)
STT_MODES: tuple[str, ...] = typing.get_args(SarvamSTTModes)
LLM_MODELS: tuple[str, ...] = typing.get_args(SarvamLLMModels)
TTS_MODELS: tuple[str, ...] = typing.get_args(SarvamTTSModels)
TTS_LANGUAGES: tuple[str, ...] = typing.get_args(SarvamTTSLanguages)

# Voices are per-model: the bulbul:v2 roster was replaced wholesale in v3, so a
# speaker is only valid against the model it ships with.
def tts_speakers(model: str) -> tuple[str, ...]:
    return tuple(MODEL_SPEAKER_COMPATIBILITY[model]["all"])


def _env(name: str, default: str) -> str:
    """Read a variable, treating empty/whitespace values as unset."""
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


def _env_opt(name: str) -> str | None:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else None


def _env_list(name: str) -> tuple[str, ...]:
    """Read a comma-separated variable, dropping blanks and stray whitespace."""
    raw = _env_opt(name)
    if raw is None:
        return ()
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def _env_bool(name: str, default: bool) -> bool:
    raw = _env_opt(name)
    if raw is None:
        return default
    return raw.lower() not in {"0", "false", "no", "off"}


def _env_float(name: str, default: float) -> float:
    raw = _env_opt(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc


def _env_choice(
    name: str, default: str, valid: tuple[str, ...], *, context: str = ""
) -> str:
    """Read a variable that must be one of a known set of values."""
    value = _env(name, default)
    if value not in valid:
        where = f" for {context}" if context else ""
        raise ValueError(
            f"{name}={value!r} is not a valid Sarvam value{where}. "
            f"Choose one of: {', '.join(valid)}."
        )
    return value


# The dealership runs on India time, and the closing line the agent must say
# depends on the hour, so the prompt carries the wall-clock time of the call.
AGENT_TIMEZONE = "Asia/Kolkata"


def current_time_line(now: datetime | None = None) -> str:
    """A line stating the current date and time, for the system prompt.

    A language model has no clock. Scripts that branch on the time of day (for
    example "call back tomorrow morning" versus "in ten minutes") therefore need
    it stated explicitly, or the model guesses and picks the wrong branch.
    """
    if now is None:
        now = datetime.now(ZoneInfo(AGENT_TIMEZONE))
    return (
        "The current date and time of this call is: "
        + now.strftime("%A, %d %B %Y, %I:%M %p")
        + " India time."
    )


@dataclass(frozen=True)
class AgentConfig:
    """Fully resolved agent settings."""

    stt_model: str
    stt_mode: str
    stt_language: str
    llm_model: str
    llm_temperature: float | None
    tts_model: str
    tts_language: str
    tts_speaker: str
    tts_pace: float
    persona: str
    instructions: str
    greeting: str
    budget_inr: float
    max_inr_per_min: float
    budget_warn_at: float
    budget_wrap_at: float
    budget_farewell: str
    max_response_tokens: int | None
    use_turn_detector: bool
    vad_min_silence: float
    vad_min_speech: float
    vad_activation_threshold: float
    vad_prefix_padding: float
    endpointing_min_delay: float
    endpointing_max_delay: float

    @classmethod
    def from_env(cls) -> AgentConfig:
        raw_temperature = _env_opt("LLM_TEMPERATURE")
        if raw_temperature is None:
            temperature = None
        else:
            try:
                temperature = float(raw_temperature)
            except ValueError as exc:
                raise ValueError(
                    f"LLM_TEMPERATURE must be a number, got {raw_temperature!r}"
                ) from exc

        use_turn_detector = _env_bool("USE_TURN_DETECTOR", True)

        # With semantic detection the model gives a confident end-of-turn
        # signal, so the session can commit sooner than with VAD silence alone.
        default_min_delay = 0.3 if use_turn_detector else 0.5
        default_max_delay = 2.5 if use_turn_detector else 3.0

        vad_min_silence = _env_float("VAD_MIN_SILENCE_DURATION", 0.25)
        if use_turn_detector and vad_min_silence < MIN_SILENCE_FOR_TURN_DETECTOR:
            raise ValueError(
                "VAD_MIN_SILENCE_DURATION must be at least "
                f"{MIN_SILENCE_FOR_TURN_DETECTOR} when USE_TURN_DETECTOR is on "
                f"(got {vad_min_silence}). The semantic turn detector needs that "
                "much trailing silence to classify the turn."
            )

        # The voice roster changed between bulbul generations, so the default
        # speaker follows the chosen model rather than being a fixed name that
        # would be rejected on half of them.
        tts_model = _env_choice("TTS_MODEL", "bulbul:v3", TTS_MODELS)
        speakers = tts_speakers(tts_model)
        default_speaker = "ritu" if tts_model != "bulbul:v2" else "anushka"
        tts_speaker = _env_choice(
            "TTS_SPEAKER", default_speaker, speakers, context=tts_model
        )

        # A per-call ceiling in INR. 0 disables it. The stages must stay in
        # order or the call would be told to wrap up before it is warned.
        budget_inr = _env_float("CALL_BUDGET_INR", 0.0)
        # A ceiling on cost per minute, which is what a per-minute price
        # depends on. 0 disables it.
        max_inr_per_min = _env_float("MAX_INR_PER_MIN", 0.0)
        budget_warn_at = _env_float("CALL_BUDGET_WARN_AT", 0.70)
        budget_wrap_at = _env_float("CALL_BUDGET_WRAP_AT", 0.90)
        if budget_inr > 0 and not 0 < budget_warn_at <= budget_wrap_at < 1:
            raise ValueError(
                "CALL_BUDGET_WARN_AT and CALL_BUDGET_WRAP_AT must satisfy "
                f"0 < warn <= wrap < 1 (got warn={budget_warn_at}, "
                f"wrap={budget_wrap_at}). They are fractions of CALL_BUDGET_INR."
            )

        raw_max_tokens = _env_opt("MAX_RESPONSE_TOKENS")
        if raw_max_tokens is None:
            max_response_tokens = None
        else:
            try:
                max_response_tokens = int(raw_max_tokens)
            except ValueError as exc:
                raise ValueError(
                    f"MAX_RESPONSE_TOKENS must be a whole number, "
                    f"got {raw_max_tokens!r}"
                ) from exc
            if max_response_tokens <= 0:
                raise ValueError(
                    "MAX_RESPONSE_TOKENS must be greater than 0, or unset to "
                    "leave replies unbounded."
                )

        persona = get_persona(_env("AGENT_PERSONA", DEFAULT_PERSONA))

        # A custom prompt replaces the persona's character, but still gets the
        # shared voice rules prepended -- otherwise a user writing their own
        # personality silently loses the no-markdown, stay-brief constraints
        # that make output work as speech.
        custom_instructions = _env_opt("AGENT_INSTRUCTIONS")
        if custom_instructions:
            instructions = f"{VOICE_BASE_RULES}\n\n{custom_instructions}"
        else:
            instructions = persona.instructions()

        # Stamped last so it is the freshest thing in the prompt, and so a
        # custom AGENT_INSTRUCTIONS gets it too.
        instructions = f"{instructions}\n\n{current_time_line()}"

        return cls(
            # saaras:v4 is Sarvam's current speech model; "codemix" keeps
            # English+Hindi mixed speech as spoken, which is how people
            # actually talk, instead of forcing it into one script.
            stt_model=_env_choice("STT_MODEL", "saaras:v4", STT_MODELS),
            stt_mode=_env_choice("STT_MODE", "codemix", STT_MODES),
            stt_language=_env("STT_LANGUAGE", "hi-IN"),
            # sarvam-105b-conversations is tuned for multi-turn dialogue, and
            # is the model generally available: sarvam-105b, gemma4 and glm5.2
            # are gated behind beta access and return 400 without it.
            llm_model=_env_choice(
                "LLM_MODEL", "sarvam-105b-conversations", LLM_MODELS
            ),
            llm_temperature=temperature,
            tts_model=tts_model,
            tts_language=_env_choice("TTS_LANGUAGE", "hi-IN", TTS_LANGUAGES),
            tts_speaker=tts_speaker,
            tts_pace=_env_float("TTS_PACE", 1.0),
            persona=persona.name,
            instructions=instructions,
            greeting=_env("AGENT_GREETING", persona.greeting),
            budget_inr=budget_inr,
            max_inr_per_min=max_inr_per_min,
            budget_warn_at=budget_warn_at,
            budget_wrap_at=budget_wrap_at,
            budget_farewell=_env(
                "CALL_BUDGET_FAREWELL",
                "Thank the user warmly, tell them the call has to end now, "
                "and invite them to call back if they need anything more.",
            ),
            max_response_tokens=max_response_tokens,
            use_turn_detector=use_turn_detector,
            vad_min_silence=vad_min_silence,
            vad_min_speech=_env_float("VAD_MIN_SPEECH_DURATION", 0.05),
            vad_activation_threshold=_env_float("VAD_ACTIVATION_THRESHOLD", 0.5),
            vad_prefix_padding=_env_float("VAD_PREFIX_PADDING_DURATION", 0.5),
            endpointing_min_delay=_env_float("ENDPOINTING_MIN_DELAY", default_min_delay),
            endpointing_max_delay=_env_float("ENDPOINTING_MAX_DELAY", default_max_delay),
        )

    def describe(self) -> str:
        mode = "semantic+vad" if self.use_turn_detector else "vad-only"
        budget = (
            f"budget=Rs {self.budget_inr:.2f}/call "
            if self.budget_inr > 0
            else "budget=off "
        )
        return (
            f"{budget}"
            f"persona={self.persona} "
            f"stt={self.stt_model} (mode={self.stt_mode}, "
            f"lang={self.stt_language}) "
            f"llm={self.llm_model} "
            f"tts={self.tts_model} (speaker={self.tts_speaker}, "
            f"lang={self.tts_language}) "
            f"turn_detection={mode} "
            f"vad(min_silence={self.vad_min_silence}s, "
            f"threshold={self.vad_activation_threshold}) "
            f"endpointing({self.endpointing_min_delay}s-{self.endpointing_max_delay}s)"
        )
