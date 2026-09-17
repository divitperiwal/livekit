"""Building a configuration from a stored agent version.

``from_record`` is how a call gets its configuration in production;
``from_env`` is the local-development path. The tests that matter most here are
the ones asserting the two agree, because the environment path is meant to be a
convenience rather than a second set of rules.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from automitra_worker.config import AgentConfig
from automitra_worker.personas import VOICE_BASE_RULES, get_persona


def record(**config: object) -> dict:
    """A minimal stored version, with config overrides applied."""
    return {
        "agent_slug": "test-agent",
        "instructions": "You are a helpful assistant.",
        "greeting": "Say hello.",
        "config": config,
    }


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "STT_MODEL", "STT_MODE", "STT_LANGUAGE", "LLM_MODEL", "LLM_TEMPERATURE",
        "TTS_MODEL", "TTS_LANGUAGE", "TTS_SPEAKER", "TTS_PACE",
        "AGENT_PERSONA", "AGENT_INSTRUCTIONS", "AGENT_GREETING", "AGENT_TIMEZONE",
        "CALL_BUDGET_INR", "MAX_INR_PER_MIN", "CALL_BUDGET_WARN_AT",
        "CALL_BUDGET_WRAP_AT", "CALL_BUDGET_FAREWELL", "MAX_RESPONSE_TOKENS",
        "USE_TURN_DETECTOR", "VAD_MIN_SILENCE_DURATION", "VAD_MIN_SPEECH_DURATION",
        "VAD_ACTIVATION_THRESHOLD", "VAD_PREFIX_PADDING_DURATION",
        "ENDPOINTING_MIN_DELAY", "ENDPOINTING_MAX_DELAY",
    ):
        monkeypatch.delenv(name, raising=False)


# --- the two paths agree ----------------------------------------------------


def test_defaults_match_between_env_and_record() -> None:
    """The test that makes the refactor safe.

    Every tuning value must come out identical whether it arrived from the
    environment or from a database row. Only the prompt, the greeting and the
    persona name differ, because those are what the record supplies.
    """
    from_env = AgentConfig.from_env()
    from_record = AgentConfig.from_record(record())

    ignore = {"instructions", "greeting", "persona"}
    for field in AgentConfig.__dataclass_fields__:
        if field in ignore:
            continue
        assert getattr(from_env, field) == getattr(from_record, field), (
            f"{field} differs between the two paths"
        )


def test_an_invalid_value_is_rejected_on_both_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A speaker from the wrong model generation fails either way."""
    monkeypatch.setenv("TTS_MODEL", "bulbul:v3")
    monkeypatch.setenv("TTS_SPEAKER", "anushka")
    with pytest.raises(ValueError):
        AgentConfig.from_env()

    with pytest.raises(ValueError):
        AgentConfig.from_record(
            record(tts_model="bulbul:v3", tts_speaker="anushka")
        )


# --- key casing -------------------------------------------------------------


def test_camel_case_keys_are_accepted() -> None:
    """The control plane stores JSON camelCased; Python speaks snake_case."""
    config = AgentConfig.from_record(
        record(sttModel="saaras:v3", ttsPace=1.2, maxResponseTokens=120)
    )
    assert config.stt_model == "saaras:v3"
    assert config.tts_pace == 1.2
    assert config.max_response_tokens == 120


def test_snake_case_keys_are_also_accepted() -> None:
    config = AgentConfig.from_record(record(stt_model="saaras:v3"))
    assert config.stt_model == "saaras:v3"


# --- prompt composition -----------------------------------------------------


def test_verbatim_mode_leaves_the_prompt_alone() -> None:
    """A complete call script must not be told it is a voice assistant."""
    config = AgentConfig.from_record(record(promptMode="verbatim"))
    assert VOICE_BASE_RULES not in config.instructions
    assert config.instructions.startswith("You are a helpful assistant.")


def test_prompt_mode_is_read_from_the_record_not_only_the_config() -> None:
    """It is stored beside the prompt, not inside the config blob.

    The prompt and the rule for composing it are edited together, and a mode
    pointing at a different prompt is meaningless -- so the control plane keeps
    it as its own column. Reading it only from the blob silently prepended the
    shared voice rules to a script written to exclude them.
    """
    stored = {
        "agent_slug": "kbs",
        "instructions": "CRITICAL RULES. You are Simran.",
        "greeting": "namaskar",
        "prompt_mode": "verbatim",
        "config": {},
    }
    assert VOICE_BASE_RULES not in AgentConfig.from_record(stored).instructions

    camel = {**stored}
    del camel["prompt_mode"]
    camel["promptMode"] = "verbatim"
    assert VOICE_BASE_RULES not in AgentConfig.from_record(camel).instructions


def test_a_record_level_prompt_mode_overrides_the_config_blob() -> None:
    stored = {
        "instructions": "You are Simran.",
        "greeting": "hi",
        "prompt_mode": "verbatim",
        "config": {"promptMode": "prepend_base_rules"},
    }
    assert VOICE_BASE_RULES not in AgentConfig.from_record(stored).instructions


def test_default_mode_prepends_the_shared_rules() -> None:
    config = AgentConfig.from_record(record())
    assert config.instructions.startswith(VOICE_BASE_RULES)
    assert "You are a helpful assistant." in config.instructions


def test_the_time_is_stamped_in_either_mode() -> None:
    """A model has no clock, and a verbatim script needs one too."""
    for mode in ("verbatim", "prepend_base_rules"):
        config = AgentConfig.from_record(record(promptMode=mode))
        assert "The current date and time of this call is" in config.instructions


def test_a_record_without_a_prompt_is_rejected() -> None:
    with pytest.raises(ValueError, match="instructions"):
        AgentConfig.from_record({"instructions": "", "greeting": "hi", "config": {}})


def test_a_record_without_a_greeting_is_rejected() -> None:
    with pytest.raises(ValueError, match="greeting"):
        AgentConfig.from_record({"instructions": "hi", "greeting": "", "config": {}})


# --- timezone ---------------------------------------------------------------


def test_timezone_is_named_rather_than_described() -> None:
    """A US customer must not be told their caller is on India time."""
    config = AgentConfig.from_record(record(timezone="America/New_York"))
    assert "America/New_York" in config.instructions
    assert "India" not in config.instructions


def test_timezone_defaults_to_india() -> None:
    config = AgentConfig.from_record(record())
    assert config.timezone == "Asia/Kolkata"


def test_an_unknown_timezone_is_rejected() -> None:
    with pytest.raises(ValueError, match="timezone"):
        AgentConfig.from_record(record(timezone="Mars/Olympus"))


# --- validation reaches the record path -------------------------------------


@pytest.mark.parametrize(
    "config",
    [
        {"sttModel": "saaras:v9"},
        {"llmModel": "gpt-4"},
        {"ttsPace": 0},
        {"maxResponseTokens": 0},
        {"budgetInr": 50, "budgetWarnAt": 0.95, "budgetWrapAt": 0.80},
        {"useTurnDetector": True, "vadMinSilence": 0.1},
        {"endpointingMinDelay": 3.0, "endpointingMaxDelay": 1.0},
        {"llmTemperature": 5.0},
        {"nonsenseField": 1},
    ],
)
def test_invalid_configurations_are_rejected(config: dict) -> None:
    with pytest.raises(ValueError):
        AgentConfig.from_record(record(**config))


def test_the_config_is_still_frozen() -> None:
    """Nothing may mutate a configuration mid-call."""
    config = AgentConfig.from_record(record())
    with pytest.raises(Exception):
        config.stt_model = "saaras:v3"  # type: ignore[misc]
    # `replace` is the supported way to derive a variant.
    assert replace(config, stt_model="saaras:v3").stt_model == "saaras:v3"


# --- persona-free operation -------------------------------------------------


def test_a_stored_agent_needs_no_persona() -> None:
    """The database row replaces the concept; the name is kept for logs."""
    config = AgentConfig.from_record(record())
    assert config.persona == "test-agent"


def test_persona_falls_back_when_the_record_does_not_name_one() -> None:
    config = AgentConfig.from_record(
        {"instructions": "hi", "greeting": "hello", "config": {}}
    )
    assert config.persona == "custom"


def test_a_standalone_persona_still_works_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The env path must keep honouring `standalone`, which predates prompt_mode."""
    monkeypatch.setenv("AGENT_PERSONA", "kbs")
    config = AgentConfig.from_env()
    assert VOICE_BASE_RULES not in config.instructions
    assert get_persona("kbs").prompt.split("\n")[0] in config.instructions
