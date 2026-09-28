"""Runtime configuration for the voice agent.

``AgentConfig`` is what the rest of the worker uses: a frozen, fully resolved
value with no optional fields left to interpret. It can be built two ways.

``from_record`` takes a stored agent version, which is how a call gets its
configuration in production. ``from_env`` reads environment variables, which is
how local development and ``uv run agent console`` work, and is the fallback
when a job arrives with no metadata.

Both funnel through :class:`AgentConfigModel`, so a value rejected on one path
is rejected on the other. That is the point: the environment path is a
developer convenience, not a second set of rules.
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping
from zoneinfo import ZoneInfo

from .agent_config_model import (
    DEFAULT_TIMEZONE,
    LLM_MODELS,
    MIN_SILENCE_FOR_TURN_DETECTOR,
    STT_MODELS,
    STT_MODES,
    TTS_LANGUAGES,
    TTS_MODELS,
    AgentConfigModel,
    AnalysisField,
    ClosingLine,
    TransferTarget,
    default_speaker,
    tts_speakers,
)
from .budget import PLATFORM_MAX_INR_PER_MIN
from .personas import DEFAULT_PERSONA, VOICE_BASE_RULES, get_persona
from .variables import render

__all__ = [
    "AgentConfig",
    "AgentConfigModel",
    "LLM_MODELS",
    "MIN_SILENCE_FOR_TURN_DETECTOR",
    "STT_MODELS",
    "STT_MODES",
    "TTS_LANGUAGES",
    "TTS_MODELS",
    "current_time_line",
    "tts_speakers",
]


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


def current_time_line(
    now: datetime | None = None, timezone: str = DEFAULT_TIMEZONE
) -> str:
    """A line stating the current date and time, for the system prompt.

    A language model has no clock. Scripts that branch on the time of day (for
    example "call back tomorrow morning" versus "in ten minutes") therefore need
    it stated explicitly, or the model guesses and picks the wrong branch.

    The zone is named rather than described, so an agent outside India does not
    get told its caller is on India time.
    """
    zone = ZoneInfo(timezone)
    if now is None:
        now = datetime.now(zone)
    else:
        now = now.astimezone(zone)
    return (
        "The current date and time of this call is: "
        + now.strftime("%A, %d %B %Y, %I:%M %p")
        + f" ({timezone})."
    )


def compose_instructions(prompt: str, *, prompt_mode: str, timezone: str) -> str:
    """Assemble the system prompt an agent actually runs on.

    ``prepend_base_rules`` puts the shared voice rules first: the constraints
    that follow from speech as a medium rather than from any personality.
    ``verbatim`` leaves the prompt alone, for a complete call script that
    states its own rules and would be contradicted by them.

    The time is stamped last either way, so it is the freshest thing in the
    prompt and a verbatim script gets it too.
    """
    body = prompt.strip() if prompt_mode == "verbatim" else f"{VOICE_BASE_RULES}\n\n{prompt.strip()}"
    return f"{body}\n\n{current_time_line(timezone=timezone)}"


@dataclass(frozen=True)
class AgentConfig:
    """Fully resolved agent settings.

    Everything here is decided: no field means "work it out later". The
    endpointing window has its mode-dependent defaults filled in, the prompt is
    composed, and every value has been validated.
    """

    stt_model: str
    stt_mode: str
    stt_language: str
    stt_realtime: bool
    llm_model: str
    llm_temperature: float | None
    tts_model: str
    tts_language: str
    tts_speaker: str
    tts_pace: float
    persona: str
    instructions: str
    greeting: str
    greeting_mode: str
    recording_notice: str
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
    timezone: str
    end_call_enabled: bool
    closing_lines: tuple[ClosingLine, ...]
    transfer_targets: tuple[TransferTarget, ...]
    voicemail_detection: bool
    voicemail_action: str
    voicemail_message: str
    analysis_enabled: bool
    dispositions: tuple[str, ...]
    analysis_fields: tuple[AnalysisField, ...]
    qa_criteria: tuple[str, ...]
    silence_timeout: float
    silence_checks: int
    dtmf_input: bool
    fallback_llm: str | None
    fallback_stt: str | None
    fallback_tts: str | None
    fallback_tts_voice: str

    # --- construction -------------------------------------------------------

    @classmethod
    def _build(
        cls,
        model: AgentConfigModel,
        *,
        prompt: str,
        greeting: str,
        persona: str,
    ) -> AgentConfig:
        """The one path from a validated model to a usable config."""
        min_delay, max_delay = model.resolved_endpointing()
        return cls(
            stt_model=model.stt_model,
            stt_mode=model.stt_mode,
            stt_language=model.stt_language,
            stt_realtime=model.stt_realtime,
            llm_model=model.llm_model,
            llm_temperature=model.llm_temperature,
            tts_model=model.tts_model,
            tts_language=model.tts_language,
            tts_speaker=model.tts_speaker,
            tts_pace=model.tts_pace,
            persona=persona,
            instructions=compose_instructions(
                prompt, prompt_mode=model.prompt_mode, timezone=model.timezone
            ),
            greeting=greeting,
            greeting_mode=model.greeting_mode,
            recording_notice=model.recording_notice,
            budget_inr=model.budget_inr,
            max_inr_per_min=model.max_inr_per_min,
            budget_warn_at=model.budget_warn_at,
            budget_wrap_at=model.budget_wrap_at,
            budget_farewell=model.budget_farewell,
            max_response_tokens=model.max_response_tokens,
            use_turn_detector=model.use_turn_detector,
            vad_min_silence=model.vad_min_silence,
            vad_min_speech=model.vad_min_speech,
            vad_activation_threshold=model.vad_activation_threshold,
            vad_prefix_padding=model.vad_prefix_padding,
            endpointing_min_delay=min_delay,
            endpointing_max_delay=max_delay,
            timezone=model.timezone,
            end_call_enabled=model.end_call_enabled,
            closing_lines=tuple(model.closing_lines),
            transfer_targets=tuple(model.transfer_targets),
            voicemail_detection=model.voicemail_detection,
            voicemail_action=model.voicemail_action,
            voicemail_message=model.voicemail_message,
            analysis_enabled=model.analysis_enabled,
            dispositions=tuple(model.dispositions),
            analysis_fields=tuple(model.analysis_fields),
            qa_criteria=tuple(model.qa_criteria),
            silence_timeout=model.silence_timeout,
            silence_checks=model.silence_checks,
            dtmf_input=model.dtmf_input,
            fallback_llm=model.fallback_llm,
            fallback_stt=model.fallback_stt,
            fallback_tts=model.fallback_tts,
            fallback_tts_voice=model.fallback_tts_voice,
        )

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> AgentConfig:
        """Build from a stored agent version.

        ``record`` is the shape the control plane serves: the version's
        ``config`` object plus its ``instructions`` and ``greeting``, which are
        separate columns because they are large and edited independently.

        Keys are accepted in either camelCase or snake_case, because the
        control plane stores JSON in the former and Python speaks the latter.
        """
        config = {_snake(k): v for k, v in (record.get("config") or {}).items()}
        prompt = record.get("instructions")
        greeting = record.get("greeting")

        if not prompt:
            raise ValueError("agent version has no instructions")
        if not greeting:
            raise ValueError("agent version has no greeting")

        # ``prompt_mode`` is stored beside the prompt it governs rather than
        # inside the config blob, since the two are edited together and a mode
        # pointing at a different prompt is meaningless. A record supplying it
        # at the top level therefore wins over anything in the blob.
        stored_mode = record.get("prompt_mode") or record.get("promptMode")
        if stored_mode:
            config["prompt_mode"] = stored_mode

        model = AgentConfigModel.model_validate(config)
        return cls._build(
            model,
            prompt=prompt,
            greeting=greeting,
            # Stored agents have no persona: the database row replaces the
            # concept outright. The name is kept for log lines.
            persona=record.get("agent_slug") or record.get("agentSlug") or "custom",
        )

    @classmethod
    def from_env(cls) -> AgentConfig:
        """Build from environment variables, for local development.

        Values are read, then validated by the same model a stored record goes
        through. Where a variable is unset the model's own default applies, so
        the two paths cannot drift apart.
        """
        # The voice roster changed between bulbul generations, so the default
        # speaker follows the chosen model rather than being a fixed name that
        # would be rejected on half of them.
        tts_model = _env("TTS_MODEL", "bulbul:v3")

        use_turn_detector = _env_bool("USE_TURN_DETECTOR", True)
        timezone = _env("AGENT_TIMEZONE", DEFAULT_TIMEZONE)

        raw: dict[str, Any] = {
            "stt_model": _env("STT_MODEL", "saaras:v4"),
            "stt_mode": _env("STT_MODE", "codemix"),
            "stt_language": _env("STT_LANGUAGE", "hi-IN"),
            "stt_realtime": _env_bool("STT_REALTIME", True),
            "llm_model": _env("LLM_MODEL", "sarvam-105b-conversations"),
            "llm_temperature": _env_number("LLM_TEMPERATURE", float),
            "max_response_tokens": _env_number("MAX_RESPONSE_TOKENS", int),
            "tts_model": tts_model,
            "tts_language": _env("TTS_LANGUAGE", "hi-IN"),
            "tts_speaker": _env("TTS_SPEAKER", _safe_default_speaker(tts_model)),
            "tts_pace": _env_float("TTS_PACE", 1.0),
            "budget_inr": _env_float("CALL_BUDGET_INR", 0.0),
            "max_inr_per_min": _env_float("MAX_INR_PER_MIN", PLATFORM_MAX_INR_PER_MIN),
            "budget_warn_at": _env_float("CALL_BUDGET_WARN_AT", 0.70),
            "budget_wrap_at": _env_float("CALL_BUDGET_WRAP_AT", 0.90),
            "use_turn_detector": use_turn_detector,
            "vad_min_silence": _env_float("VAD_MIN_SILENCE_DURATION", 0.25),
            "vad_min_speech": _env_float("VAD_MIN_SPEECH_DURATION", 0.05),
            "vad_activation_threshold": _env_float("VAD_ACTIVATION_THRESHOLD", 0.5),
            "vad_prefix_padding": _env_float("VAD_PREFIX_PADDING_DURATION", 0.5),
            "endpointing_min_delay": _env_number("ENDPOINTING_MIN_DELAY", float),
            "endpointing_max_delay": _env_number("ENDPOINTING_MAX_DELAY", float),
            "timezone": timezone,
            "end_call_enabled": _env_bool("END_CALL_ENABLED", True),
        }
        farewell = _env_opt("CALL_BUDGET_FAREWELL")
        if farewell:
            raw["budget_farewell"] = farewell

        persona = get_persona(_env("AGENT_PERSONA", DEFAULT_PERSONA))

        # A custom prompt replaces the persona's character. It is treated as
        # "prepend the shared rules" because someone writing a personality in a
        # variable has not written the no-markdown, stay-brief constraints that
        # make output work as speech. A prompt that does state its own rules
        # belongs in a persona, or in a stored agent with prompt_mode=verbatim.
        custom = _env_opt("AGENT_INSTRUCTIONS")
        if custom:
            prompt, prompt_mode = custom, "prepend_base_rules"
        else:
            prompt = persona.prompt
            prompt_mode = "verbatim" if persona.standalone else "prepend_base_rules"
            if persona.closing_lines:
                raw["closing_lines"] = [line.model_dump() for line in persona.closing_lines]
        raw["prompt_mode"] = prompt_mode

        # A greeting from the variable is read as an instruction, as it always
        # has been; only the persona's own can be known to be exact words.
        greeting = _env_opt("AGENT_GREETING")
        if greeting is None and persona.verbatim_greeting:
            raw["greeting_mode"] = "verbatim"

        model = _validate_env(raw)
        return cls._build(
            model,
            prompt=prompt,
            greeting=greeting or persona.greeting,
            persona=persona.name,
        )

    def with_variables(self, values: Mapping[str, str]) -> AgentConfig:
        """This configuration with one call's ``{{placeholders}}`` filled in.

        Applied even when there are no values, so that a placeholder with a
        default still renders it and one without renders as nothing -- never as
        braces read aloud.
        """
        return dataclasses.replace(
            self,
            instructions=render(self.instructions, values),
            greeting=render(self.greeting, values),
            voicemail_message=render(self.voicemail_message, values),
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


def _snake(name: str) -> str:
    """camelCase to snake_case, for keys arriving as JSON."""
    out: list[str] = []
    for char in name:
        if char.isupper():
            out.append("_")
            out.append(char.lower())
        else:
            out.append(char)
    return "".join(out)


def _safe_default_speaker(tts_model: str) -> str:
    """A default voice, without raising on a model we do not recognise.

    An unknown model is the model field's error to report, with the list of
    valid ones. Raising a KeyError here first would replace that message with a
    worse one.
    """
    try:
        return default_speaker(tts_model)
    except KeyError:
        return "ritu"


def _env_number(name: str, kind: type) -> Any:
    """Read an optional numeric variable, unset meaning None."""
    raw = _env_opt(name)
    if raw is None:
        return None
    try:
        return kind(raw)
    except ValueError as exc:
        what = "a whole number" if kind is int else "a number"
        raise ValueError(f"{name} must be {what}, got {raw!r}") from exc


# Environment variable names, for error messages. The model reports a field
# name; someone editing a .env file needs the variable they actually typed.
_ENV_NAMES = {
    "stt_model": "STT_MODEL",
    "stt_mode": "STT_MODE",
    "stt_language": "STT_LANGUAGE",
    "stt_realtime": "STT_REALTIME",
    "llm_model": "LLM_MODEL",
    "llm_temperature": "LLM_TEMPERATURE",
    "max_response_tokens": "MAX_RESPONSE_TOKENS",
    "tts_model": "TTS_MODEL",
    "tts_language": "TTS_LANGUAGE",
    "tts_speaker": "TTS_SPEAKER",
    "tts_pace": "TTS_PACE",
    "budget_inr": "CALL_BUDGET_INR",
    "max_inr_per_min": "MAX_INR_PER_MIN",
    "budget_warn_at": "CALL_BUDGET_WARN_AT",
    "budget_wrap_at": "CALL_BUDGET_WRAP_AT",
    "budget_farewell": "CALL_BUDGET_FAREWELL",
    "use_turn_detector": "USE_TURN_DETECTOR",
    "vad_min_silence": "VAD_MIN_SILENCE_DURATION",
    "vad_min_speech": "VAD_MIN_SPEECH_DURATION",
    "vad_activation_threshold": "VAD_ACTIVATION_THRESHOLD",
    "vad_prefix_padding": "VAD_PREFIX_PADDING_DURATION",
    "endpointing_min_delay": "ENDPOINTING_MIN_DELAY",
    "endpointing_max_delay": "ENDPOINTING_MAX_DELAY",
    "timezone": "AGENT_TIMEZONE",
    "end_call_enabled": "END_CALL_ENABLED",
}


def _validate_env(raw: Mapping[str, Any]) -> AgentConfigModel:
    """Validate environment-derived values, reporting variable names.

    The model speaks in field names. Someone who typed ``TTS_SPEAKER=anushka``
    needs to be told about ``TTS_SPEAKER``, not about ``tts_speaker``.
    """
    from pydantic import ValidationError

    try:
        return AgentConfigModel.model_validate(dict(raw))
    except ValidationError as exc:
        lines = []
        for error in exc.errors():
            field = str(error["loc"][0]) if error["loc"] else ""
            name = _ENV_NAMES.get(field, field)
            message = error["msg"].removeprefix("Value error, ")
            for stored, variable in _ENV_NAMES.items():
                message = message.replace(stored, variable)
            lines.append(f"{name}: {message}" if name else message)
        raise ValueError("; ".join(lines)) from exc
