"""Single-tenant dev mode: an agent built from environment variables.

Used by `agent console` and local development when INTERNAL_API_SECRET is unset. Values
go through the same `AgentConfigModel` as a stored agent, so the two paths cannot drift.
"""

import os
from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError
from pydantic.alias_generators import to_camel

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.agent_config.personas import DEFAULT_PERSONA, get_persona
from automitra_worker.agent_config.runtime import RuntimeAgent

# The variable someone editing a .env file actually typed, for each field.
ENVIRONMENT_VARIABLE_BY_FIELD = {
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
    "silence_timeout": "SILENCE_TIMEOUT",
    "silence_checks": "SILENCE_CHECKS",
    "dtmf_input": "DTMF_INPUT",
    "voicemail_detection": "VOICEMAIL_DETECTION",
    "voicemail_action": "VOICEMAIL_ACTION",
    "voicemail_message": "VOICEMAIL_MESSAGE",
    "fallback_stt": "FALLBACK_STT",
    "fallback_llm": "FALLBACK_LLM",
    "fallback_tts": "FALLBACK_TTS",
    "fallback_tts_voice": "FALLBACK_TTS_VOICE",
}
_TEXT_FIELDS = {
    "stt_model",
    "stt_mode",
    "stt_language",
    "llm_model",
    "tts_model",
    "tts_language",
    "tts_speaker",
    "budget_farewell",
    "timezone",
    "voicemail_action",
    "voicemail_message",
    "fallback_stt",
    "fallback_llm",
    "fallback_tts",
    "fallback_tts_voice",
}
_BOOLEAN_FIELDS = {
    "stt_realtime",
    "use_turn_detector",
    "end_call_enabled",
    "dtmf_input",
    "voicemail_detection",
}
_INTEGER_FIELDS = {"max_response_tokens", "silence_checks"}
_FALSE_WORDS = {"0", "false", "no", "off"}


def agent_from_environment(environ: Mapping[str, str] = os.environ) -> RuntimeAgent:
    """Unset variables take the model's own defaults.

    AGENT_INSTRUCTIONS replaces the persona's prompt and always gets the shared voice
    rules; a prompt that states its own rules belongs in a persona or a stored agent.
    """
    raw_config = _config_values(environ)
    persona = get_persona(_value(environ, "AGENT_PERSONA") or DEFAULT_PERSONA)

    custom_prompt = _value(environ, "AGENT_INSTRUCTIONS")
    if custom_prompt:
        prompt, raw_config["prompt_mode"] = custom_prompt, "prepend_base_rules"
    else:
        prompt = persona.prompt
        raw_config["prompt_mode"] = "verbatim" if persona.standalone else "prepend_base_rules"
        if persona.closing_lines:
            raw_config["closing_lines"] = [line.model_dump() for line in persona.closing_lines]

    # A greeting from the environment is an instruction; only a persona's own greeting
    # can be known to be exact words.
    custom_greeting = _value(environ, "AGENT_GREETING")
    if custom_greeting is None and persona.verbatim_greeting:
        raw_config["greeting_mode"] = "verbatim"

    return RuntimeAgent.compose(
        _validate(raw_config),
        prompt=prompt,
        greeting=custom_greeting or persona.greeting,
        name="custom" if custom_prompt else persona.name,
    )


def _config_values(environ: Mapping[str, str]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for field, variable in ENVIRONMENT_VARIABLE_BY_FIELD.items():
        text = _value(environ, variable)
        if text is None:
            continue
        values[field] = _parse(field, variable, text)
    if "tts_speaker" not in values and values.get("tts_model") == "bulbul:v2":
        # The voice roster changed between bulbul generations; follow the chosen model.
        values["tts_speaker"] = "anushka"
    return values


def _parse(field: str, variable: str, text: str) -> Any:
    if field in _TEXT_FIELDS:
        return text
    if field in _BOOLEAN_FIELDS:
        return text.lower() not in _FALSE_WORDS
    kind, description = (int, "a whole number") if field in _INTEGER_FIELDS else (float, "a number")
    try:
        return kind(text)
    except ValueError as error:
        raise ValueError(f"{variable} must be {description}, got {text!r}") from error


def _value(environ: Mapping[str, str], name: str) -> str | None:
    text = environ.get(name, "").strip()
    return text or None


def _validate(raw_config: dict[str, Any]) -> AgentConfigModel:
    """Report problems by the variable name, not the field name."""
    try:
        return AgentConfigModel.model_validate(raw_config)
    except ValidationError as error:
        lines = []
        for problem in error.errors():
            field = str(problem["loc"][0]) if problem["loc"] else ""
            message = problem["msg"].removeprefix("Value error, ")
            for stored_field, variable in ENVIRONMENT_VARIABLE_BY_FIELD.items():
                message = message.replace(to_camel(stored_field), variable).replace(
                    stored_field, variable
                )
            name = ENVIRONMENT_VARIABLE_BY_FIELD.get(field, field)
            lines.append(f"{name}: {message}" if name else message)
        raise ValueError("; ".join(lines)) from error
