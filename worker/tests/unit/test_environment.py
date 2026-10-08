import pytest

from automitra_worker.agent_config.environment import agent_from_environment
from automitra_worker.agent_config.personas import get_persona
from automitra_worker.pipeline.prompt import VOICE_BASE_RULES


def test_defaults_are_a_working_agent():
    agent = agent_from_environment({})
    assert (agent.config.stt_model, agent.config.stt_mode) == ("saaras:v4", "codemix")
    assert agent.config.llm_model == "sarvam-105b-conversations"
    assert (agent.config.tts_model, agent.config.tts_speaker) == ("bulbul:v3", "ritu")
    assert agent.name == "assistant"
    assert agent.config.use_turn_detector is True


def test_a_blank_variable_is_treated_as_unset():
    assert agent_from_environment({"TTS_SPEAKER": "   "}).config.tts_speaker == "ritu"


def test_unknown_stt_model_is_rejected_with_the_valid_list():
    with pytest.raises(ValueError) as error:
        agent_from_environment({"STT_MODEL": "saaras:v9"})
    assert "STT_MODEL" in str(error.value) and "saaras:v4" in str(error.value)


@pytest.mark.parametrize(("variable", "value"), [("STT_MODE", "shouting"), ("LLM_MODEL", "gpt-4")])
def test_problems_name_the_variable_not_the_field(variable, value):
    with pytest.raises(ValueError, match=variable):
        agent_from_environment({variable: value})


def test_a_voice_from_another_bulbul_generation_is_rejected():
    with pytest.raises(ValueError, match="bulbul:v3"):
        agent_from_environment({"TTS_MODEL": "bulbul:v3", "TTS_SPEAKER": "anushka"})


def test_default_voice_follows_the_chosen_model():
    assert agent_from_environment({"TTS_MODEL": "bulbul:v2"}).config.tts_speaker == "anushka"
    assert (
        agent_from_environment({"TTS_MODEL": "bulbul:v2", "TTS_SPEAKER": "arya"}).config.tts_speaker
        == "arya"
    )


def test_turn_detector_needs_enough_trailing_silence():
    with pytest.raises(ValueError, match="VAD_MIN_SILENCE_DURATION"):
        agent_from_environment({"USE_TURN_DETECTOR": "true", "VAD_MIN_SILENCE_DURATION": "0.1"})
    allowed = agent_from_environment(
        {"USE_TURN_DETECTOR": "false", "VAD_MIN_SILENCE_DURATION": "0.1"}
    )
    assert allowed.config.vad_min_silence == 0.1


@pytest.mark.parametrize("text", ["0", "false", "no", "off", "FALSE", "Off"])
def test_false_words_switch_a_boolean_off(text):
    assert agent_from_environment({"USE_TURN_DETECTOR": text}).config.use_turn_detector is False


def test_budget_stages_must_be_ordered_only_when_a_budget_is_set():
    with pytest.raises(ValueError, match="CALL_BUDGET"):
        agent_from_environment(
            {"CALL_BUDGET_INR": "50", "CALL_BUDGET_WARN_AT": "0.95", "CALL_BUDGET_WRAP_AT": "0.80"}
        )
    agent_from_environment(
        {"CALL_BUDGET_INR": "0", "CALL_BUDGET_WARN_AT": "0.95", "CALL_BUDGET_WRAP_AT": "0.80"}
    )


def test_wrap_at_one_leaves_no_room_for_a_farewell():
    with pytest.raises(ValueError):
        agent_from_environment({"CALL_BUDGET_INR": "50", "CALL_BUDGET_WRAP_AT": "1.0"})


def test_zero_rate_ceiling_means_the_platform_ceiling():
    assert agent_from_environment({"MAX_INR_PER_MIN": "0"}).config.effective_max_inr_per_min == 2.5


def test_numbers_that_do_not_parse_name_the_variable():
    with pytest.raises(ValueError, match="LLM_TEMPERATURE"):
        agent_from_environment({"LLM_TEMPERATURE": "warm"})
    with pytest.raises(ValueError, match="whole number"):
        agent_from_environment({"MAX_RESPONSE_TOKENS": "1.5"})
    with pytest.raises(ValueError, match="MAX_RESPONSE_TOKENS"):
        agent_from_environment({"MAX_RESPONSE_TOKENS": "0"})


def test_silence_handling_is_configurable():
    config = agent_from_environment({"SILENCE_TIMEOUT": "10", "SILENCE_CHECKS": "1"}).config
    assert (config.silence_timeout, config.silence_checks) == (10.0, 1)
    with pytest.raises(ValueError, match="SILENCE_TIMEOUT"):
        agent_from_environment({"SILENCE_TIMEOUT": "3"})


def test_voicemail_and_keypad_are_configurable():
    config = agent_from_environment(
        {
            "VOICEMAIL_ACTION": "leave_message",
            "VOICEMAIL_MESSAGE": "Call us back.",
            "DTMF_INPUT": "off",
        }
    ).config
    assert (config.voicemail_action, config.voicemail_message, config.dtmf_input) == (
        "leave_message",
        "Call us back.",
        False,
    )
    with pytest.raises(ValueError, match="VOICEMAIL_ACTION"):
        agent_from_environment({"VOICEMAIL_ACTION": "sing"})


def test_unknown_fallback_model_names_the_variable():
    with pytest.raises(ValueError, match="FALLBACK_LLM"):
        agent_from_environment({"FALLBACK_LLM": "not-a-model"})


def test_unknown_persona_lists_the_valid_names():
    with pytest.raises(ValueError, match="assistant"):
        agent_from_environment({"AGENT_PERSONA": "pirate"})


def test_custom_instructions_replace_the_character_but_keep_the_voice_rules():
    agent = agent_from_environment({"AGENT_INSTRUCTIONS": "You are a pirate."})
    assert VOICE_BASE_RULES in agent.instructions
    assert "You are a pirate." in agent.instructions
    assert agent.name == "custom"


def test_greeting_comes_from_the_persona_unless_overridden():
    assert agent_from_environment({}).greeting == get_persona("assistant").greeting
    assert agent_from_environment({"AGENT_GREETING": "Say hi."}).greeting == "Say hi."


def test_a_persona_with_exact_words_greets_verbatim():
    agent = agent_from_environment({"AGENT_PERSONA": "kbs"})
    assert agent.config.greeting_mode == "verbatim"
    assert agent.config.prompt_mode == "verbatim"
    assert agent.greeting.startswith("नमस्कार")
    assert len(agent.config.closing_lines) == 3


def test_a_greeting_from_the_environment_stays_an_instruction():
    agent = agent_from_environment({"AGENT_PERSONA": "kbs", "AGENT_GREETING": "Greet the caller."})
    assert agent.config.greeting_mode == "instructions"


def test_a_custom_prompt_does_not_inherit_the_personas_closing_lines():
    agent = agent_from_environment({"AGENT_PERSONA": "kbs", "AGENT_INSTRUCTIONS": "You sell cars."})
    assert agent.config.closing_lines == []
