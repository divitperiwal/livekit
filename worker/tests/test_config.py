"""Characterization tests for configuration validation.

This is the validation that must survive the move from environment variables to
database rows. Every rule here has to hold for ``from_record`` too, and the
dashboard has to reject the same values at save time -- otherwise a bad config
is accepted in the UI and fails at three in the morning on a live call.

These tests set environment variables directly rather than through a .env file,
and ``monkeypatch`` restores them afterwards.
"""

from __future__ import annotations

import pytest

from automitra_worker.config import AgentConfig, current_time_line
from automitra_worker.personas import VOICE_BASE_RULES, get_persona


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test from a known-empty environment.

    Without this a developer's own .env.local would leak into the assertions
    and the suite would pass or fail depending on whose machine it ran on.
    """
    for name in (
        "STT_MODEL", "STT_MODE", "STT_LANGUAGE",
        "LLM_MODEL", "LLM_TEMPERATURE",
        "TTS_MODEL", "TTS_LANGUAGE", "TTS_SPEAKER", "TTS_PACE",
        "AGENT_PERSONA", "AGENT_INSTRUCTIONS", "AGENT_GREETING",
        "CALL_BUDGET_INR", "MAX_INR_PER_MIN",
        "CALL_BUDGET_WARN_AT", "CALL_BUDGET_WRAP_AT", "CALL_BUDGET_FAREWELL",
        "MAX_RESPONSE_TOKENS", "USE_TURN_DETECTOR",
        "VAD_MIN_SILENCE_DURATION", "VAD_MIN_SPEECH_DURATION",
        "VAD_ACTIVATION_THRESHOLD", "VAD_PREFIX_PADDING_DURATION",
        "ENDPOINTING_MIN_DELAY", "ENDPOINTING_MAX_DELAY",
    ):
        monkeypatch.delenv(name, raising=False)


# --- defaults ---------------------------------------------------------------


def test_defaults_are_a_working_configuration() -> None:
    config = AgentConfig.from_env()
    assert config.stt_model == "saaras:v4"
    assert config.stt_mode == "codemix"
    assert config.llm_model == "sarvam-105b-conversations"
    assert config.tts_model == "bulbul:v3"
    assert config.tts_speaker == "ritu"
    assert config.persona == "assistant"
    assert config.use_turn_detector is True


def test_empty_string_is_treated_as_unset() -> None:
    """A variable present but blank must fall back to the default.

    ``FOO=`` in a .env file is how people disable a setting, and it must not be
    read as the empty string.
    """
    import os

    os.environ["TTS_SPEAKER"] = "   "
    try:
        assert AgentConfig.from_env().tts_speaker == "ritu"
    finally:
        del os.environ["TTS_SPEAKER"]


# --- model validation -------------------------------------------------------


def test_unknown_stt_model_is_rejected_with_the_valid_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STT_MODEL", "saaras:v9")
    with pytest.raises(ValueError) as exc:
        AgentConfig.from_env()
    assert "saaras:v4" in str(exc.value)


def test_unknown_stt_mode_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STT_MODE", "shouting")
    with pytest.raises(ValueError, match="STT_MODE"):
        AgentConfig.from_env()


def test_unknown_llm_model_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL", "gpt-4")
    with pytest.raises(ValueError, match="LLM_MODEL"):
        AgentConfig.from_env()


# --- the speaker/model roster rule ------------------------------------------


def test_speaker_from_the_wrong_model_generation_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """bulbul:v3 replaced the v2 voices wholesale, so a v2 name is invalid on v3.

    This is the validation most likely to be lost in a refactor, because it is
    the only one where two fields have to agree.
    """
    monkeypatch.setenv("TTS_MODEL", "bulbul:v3")
    monkeypatch.setenv("TTS_SPEAKER", "anushka")  # a v2 voice
    with pytest.raises(ValueError) as exc:
        AgentConfig.from_env()
    assert "bulbul:v3" in str(exc.value)


def test_default_speaker_follows_the_chosen_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fixed default would be rejected on half the models."""
    monkeypatch.setenv("TTS_MODEL", "bulbul:v2")
    assert AgentConfig.from_env().tts_speaker == "anushka"


def test_v2_speaker_is_accepted_on_v2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TTS_MODEL", "bulbul:v2")
    monkeypatch.setenv("TTS_SPEAKER", "arya")
    assert AgentConfig.from_env().tts_speaker == "arya"


# --- turn detection ---------------------------------------------------------


def test_turn_detector_requires_enough_trailing_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The semantic detector classifies the trailing audio, so it needs some."""
    monkeypatch.setenv("USE_TURN_DETECTOR", "true")
    monkeypatch.setenv("VAD_MIN_SILENCE_DURATION", "0.1")
    with pytest.raises(ValueError, match="VAD_MIN_SILENCE_DURATION"):
        AgentConfig.from_env()


def test_short_silence_is_allowed_without_the_turn_detector(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("USE_TURN_DETECTOR", "false")
    monkeypatch.setenv("VAD_MIN_SILENCE_DURATION", "0.1")
    config = AgentConfig.from_env()
    assert config.use_turn_detector is False
    assert config.vad_min_silence == 0.1


def test_endpointing_defaults_adapt_to_the_detection_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Semantic detection gives a confident signal, so it can commit sooner."""
    monkeypatch.setenv("USE_TURN_DETECTOR", "true")
    semantic = AgentConfig.from_env()

    monkeypatch.setenv("USE_TURN_DETECTOR", "false")
    vad_only = AgentConfig.from_env()

    assert semantic.endpointing_min_delay < vad_only.endpointing_min_delay
    assert semantic.endpointing_max_delay < vad_only.endpointing_max_delay


@pytest.mark.parametrize("raw", ["0", "false", "no", "off", "FALSE", "Off"])
def test_falsey_strings_disable_a_boolean(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    monkeypatch.setenv("USE_TURN_DETECTOR", raw)
    assert AgentConfig.from_env().use_turn_detector is False


# --- budget ordering --------------------------------------------------------


def test_warn_after_wrap_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Otherwise the call would be told to wrap up before it is warned."""
    monkeypatch.setenv("CALL_BUDGET_INR", "50")
    monkeypatch.setenv("CALL_BUDGET_WARN_AT", "0.95")
    monkeypatch.setenv("CALL_BUDGET_WRAP_AT", "0.80")
    with pytest.raises(ValueError, match="CALL_BUDGET"):
        AgentConfig.from_env()


def test_wrap_at_one_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """At 1.0 the wrap stage and the hard stop coincide, leaving no farewell."""
    monkeypatch.setenv("CALL_BUDGET_INR", "50")
    monkeypatch.setenv("CALL_BUDGET_WRAP_AT", "1.0")
    with pytest.raises(ValueError):
        AgentConfig.from_env()


def test_stage_ordering_is_not_checked_when_the_budget_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no ceiling the fractions are unused, so they need not make sense."""
    monkeypatch.setenv("CALL_BUDGET_INR", "0")
    monkeypatch.setenv("CALL_BUDGET_WARN_AT", "0.95")
    monkeypatch.setenv("CALL_BUDGET_WRAP_AT", "0.80")
    AgentConfig.from_env()  # must not raise


# --- numeric parsing --------------------------------------------------------


def test_non_numeric_temperature_names_the_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_TEMPERATURE", "warm")
    with pytest.raises(ValueError, match="LLM_TEMPERATURE"):
        AgentConfig.from_env()


def test_temperature_unset_means_model_default() -> None:
    assert AgentConfig.from_env().llm_temperature is None


def test_zero_max_response_tokens_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unset means unbounded; zero would mean the agent cannot speak."""
    monkeypatch.setenv("MAX_RESPONSE_TOKENS", "0")
    with pytest.raises(ValueError, match="MAX_RESPONSE_TOKENS"):
        AgentConfig.from_env()


def test_fractional_max_response_tokens_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAX_RESPONSE_TOKENS", "1.5")
    with pytest.raises(ValueError, match="whole number"):
        AgentConfig.from_env()


# --- persona and instruction composition ------------------------------------


def test_unknown_persona_lists_the_valid_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_PERSONA", "pirate")
    with pytest.raises(ValueError) as exc:
        AgentConfig.from_env()
    assert "assistant" in str(exc.value)


def test_persona_lookup_is_case_insensitive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_PERSONA", "  ASSISTANT  ")
    assert AgentConfig.from_env().persona == "assistant"


def test_custom_instructions_still_get_the_shared_voice_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A custom prompt replaces the character, not the medium's constraints."""
    monkeypatch.setenv("AGENT_INSTRUCTIONS", "You are a pirate.")
    config = AgentConfig.from_env()
    assert VOICE_BASE_RULES in config.instructions
    assert "You are a pirate." in config.instructions


def test_standalone_persona_omits_the_shared_voice_rules() -> None:
    """A persona playing a named human must not be told it is a voice assistant.

    Note the asymmetry this test documents: a *persona* can opt out via
    ``standalone``, but AGENT_INSTRUCTIONS cannot. That gap is why the database
    model needs an explicit prompt mode.
    """
    kbs = get_persona("kbs")
    assert kbs.standalone
    assert VOICE_BASE_RULES not in kbs.instructions()


def test_greeting_falls_back_to_the_persona(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_PERSONA", "assistant")
    assert AgentConfig.from_env().greeting == get_persona("assistant").greeting


def test_greeting_can_be_overridden(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_GREETING", "Say hi.")
    assert AgentConfig.from_env().greeting == "Say hi."


def test_a_persona_with_exact_words_greets_verbatim(monkeypatch: pytest.MonkeyPatch) -> None:
    # No model request for the opening line: a cold one of the whole prompt
    # was the longest silence of the call.
    monkeypatch.setenv("AGENT_PERSONA", "kbs")
    config = AgentConfig.from_env()
    assert config.greeting_mode == "verbatim"
    assert config.greeting.startswith("नमस्कार")


def test_a_greeting_from_the_environment_stays_an_instruction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PERSONA", "kbs")
    monkeypatch.setenv("AGENT_GREETING", "Greet the caller.")
    assert AgentConfig.from_env().greeting_mode == "instructions"


def test_other_personas_still_greet_by_instruction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PERSONA", "assistant")
    assert AgentConfig.from_env().greeting_mode == "instructions"


def test_instructions_carry_the_wall_clock_time() -> None:
    """A model has no clock, and scripts branch on the hour.

    The time is stamped last so it is the freshest thing in the prompt, and so
    a custom AGENT_INSTRUCTIONS gets it too.
    """
    config = AgentConfig.from_env()
    assert "The current date and time of this call is" in config.instructions


def test_current_time_line_renders_a_given_moment() -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    moment = datetime(2026, 3, 14, 15, 9, tzinfo=ZoneInfo("Asia/Kolkata"))
    line = current_time_line(moment)
    assert "Saturday" in line
    assert "14 March 2026" in line
    assert "03:09 PM" in line
