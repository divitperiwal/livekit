import pytest
from livekit.agents import llm as llm_api, stt as stt_api, tts as tts_api
from livekit.plugins import sarvam

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.pipeline.realtime_stt import RealtimeSTT
from automitra_worker.pipeline.session import apply_vad_options, build_llm, build_stt, build_tts


@pytest.fixture(autouse=True)
def sarvam_api_key(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")


def test_realtime_stt_is_used_unless_switched_off():
    assert isinstance(build_stt(AgentConfigModel()), RealtimeSTT)
    batch = build_stt(AgentConfigModel(stt_realtime=False))
    assert isinstance(batch, sarvam.STT) and not isinstance(batch, RealtimeSTT)


def test_tts_streams_raw_pcm_in_the_configured_voice():
    tts = build_tts(AgentConfigModel(tts_speaker="priya", tts_pace=1.2))
    assert isinstance(tts, sarvam.TTS)
    assert (tts._opts.speaker, tts._opts.pace, tts._opts.output_audio_codec) == (
        "priya",
        1.2,
        "linear16",
    )
    assert tts.sample_rate == 24000


def test_llm_settings_are_passed_only_when_set():
    assert isinstance(build_llm(AgentConfigModel()), sarvam.LLM)
    assert isinstance(
        build_llm(AgentConfigModel(llm_temperature=0.3, max_response_tokens=120)), sarvam.LLM
    )


def test_each_configured_fallback_wraps_its_component(monkeypatch):
    monkeypatch.setenv("LIVEKIT_API_KEY", "test-key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "test-secret")
    config = AgentConfigModel(
        fallback_stt="deepgram/nova-3",
        fallback_llm="openai/gpt-4.1-mini",
        fallback_tts="cartesia/sonic-3",
    )
    assert isinstance(build_stt(config), stt_api.FallbackAdapter)
    assert isinstance(build_llm(config), llm_api.FallbackAdapter)
    assert isinstance(build_tts(config), tts_api.FallbackAdapter)


def test_the_prewarmed_vad_takes_each_calls_own_settings():
    class FakeVAD:
        def update_options(self, **options):
            self.options = options

    vad = FakeVAD()
    apply_vad_options(
        vad,
        AgentConfigModel(
            use_turn_detector=False, vad_min_silence=0.4, vad_activation_threshold=0.6
        ),
    )
    assert vad.options["min_silence_duration"] == 0.4
    assert vad.options["activation_threshold"] == 0.6
