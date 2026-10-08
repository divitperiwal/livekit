from automitra_worker.agent_config.export_schema import build_agent_config_schema
from automitra_worker.agent_config.model import (
    ENDPOINTING_DELAYS_WITH_TURN_DETECTOR,
    ENDPOINTING_DELAYS_WITHOUT_TURN_DETECTOR,
    AgentConfigModel,
)
from automitra_worker.agent_config.sarvam_catalog import TTS_MODELS, TTS_SPEAKERS_BY_MODEL


def test_worker_code_can_build_a_config_with_snake_case_names():
    config = AgentConfigModel(tts_speaker="priya", budget_inr=10)
    assert config.tts_speaker == "priya"
    assert config.budget_inr == 10


def test_stored_form_round_trips_in_camel_case():
    config = AgentConfigModel(
        tts_speaker="priya", closing_lines=[{"start": 9, "end": 17, "text": "नमस्ते"}]
    )
    stored = config.to_stored()
    assert stored["ttsSpeaker"] == "priya"
    assert stored["closingLines"] == [{"start": 9, "end": 17, "text": "नमस्ते"}]
    assert AgentConfigModel.from_stored(stored) == config


def test_endpointing_defaults_depend_on_the_turn_detector():
    assert AgentConfigModel().effective_endpointing_delays == ENDPOINTING_DELAYS_WITH_TURN_DETECTOR
    without_detector = AgentConfigModel(use_turn_detector=False)
    assert without_detector.effective_endpointing_delays == ENDPOINTING_DELAYS_WITHOUT_TURN_DETECTOR


def test_explicit_endpointing_delay_overrides_only_its_own_default():
    config = AgentConfigModel(endpointing_min_delay=0.4)
    assert config.effective_endpointing_delays == (0.4, ENDPOINTING_DELAYS_WITH_TURN_DETECTOR[1])


def test_zero_rate_ceiling_means_the_platform_ceiling():
    assert AgentConfigModel(max_inr_per_min=0).effective_max_inr_per_min == 2.5
    assert AgentConfigModel(max_inr_per_min=1.5).effective_max_inr_per_min == 1.5


def test_schema_exports_voices_for_every_tts_model_and_real_time_zones():
    schema = build_agent_config_schema()
    assert set(schema["x-tts-speakers"]) == set(TTS_MODELS)
    assert schema["x-tts-speakers"]["bulbul:v3"] == list(TTS_SPEAKERS_BY_MODEL["bulbul:v3"])
    assert "Asia/Kolkata" in schema["x-timezones"]


def test_schema_uses_the_stored_camel_case_keys_and_forbids_others():
    schema = build_agent_config_schema()
    assert "ttsSpeaker" in schema["properties"]
    assert "tts_speaker" not in schema["properties"]
    assert schema["additionalProperties"] is False
