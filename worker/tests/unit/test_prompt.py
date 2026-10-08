from datetime import datetime
from zoneinfo import ZoneInfo

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.agent_config.runtime import RuntimeAgent
from automitra_worker.pipeline.prompt import (
    SPEAKER_GENDER_LINES,
    VOICE_BASE_RULES,
    compose_instructions,
    current_time_line,
)


def test_prepend_mode_puts_the_voice_rules_before_the_prompt():
    instructions = compose_instructions(
        "You sell cars.",
        prompt_mode="prepend_base_rules",
        timezone="Asia/Kolkata",
        speaker_gender="female",
    )
    assert instructions.startswith(VOICE_BASE_RULES)
    assert "You sell cars." in instructions


def test_verbatim_mode_leaves_a_complete_script_alone():
    instructions = compose_instructions(
        "  Script.  ", prompt_mode="verbatim", timezone="Asia/Kolkata", speaker_gender="female"
    )
    assert instructions.startswith("Script.\n\n")
    assert VOICE_BASE_RULES not in instructions


def test_the_time_is_stamped_last_in_either_mode():
    for mode in ("prepend_base_rules", "verbatim"):
        instructions = compose_instructions(
            "Prompt", prompt_mode=mode, timezone="Asia/Kolkata", speaker_gender="female"
        )
        assert instructions.splitlines()[-1].startswith("The current date and time of this call is")


def test_the_time_line_renders_in_the_agents_own_zone():
    moment = datetime(2026, 3, 14, 9, 39, tzinfo=ZoneInfo("UTC"))
    line = current_time_line("Asia/Kolkata", now=moment)
    assert "Saturday, 14 March 2026, 03:09 PM" in line
    assert "(Asia/Kolkata)" in line
    assert "(America/New_York)" in current_time_line("America/New_York", now=moment)


def test_the_voices_gender_is_stated_in_either_mode():
    for mode in ("prepend_base_rules", "verbatim"):
        instructions = compose_instructions(
            "Prompt", prompt_mode=mode, timezone="Asia/Kolkata", speaker_gender="male"
        )
        assert SPEAKER_GENDER_LINES["male"] in instructions
        assert SPEAKER_GENDER_LINES["female"] not in instructions


def test_the_gender_comes_from_the_configured_tts_voice():
    def instructions_for(speaker: str) -> str:
        config = AgentConfigModel(tts_model="bulbul:v3", tts_speaker=speaker)
        return RuntimeAgent.compose(config, prompt="Prompt", greeting="", name="test").instructions

    assert "मैं बोल रही हूँ" in instructions_for("simran")
    assert "मैं बोल रहा हूँ" in instructions_for("rahul")
