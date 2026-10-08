"""Assembling the AgentSession for one call: Sarvam speech, LLM and voice, turn taking,
and optional failover to LiveKit Inference.

Turn taking is two signals. The VAD decides when audio contains speech; the semantic
turn detector then reads the trailing silence to judge whether the thought is finished,
so a mid-sentence pause is not taken as the end of a turn.
"""

from typing import Any

from livekit.agents import (
    AgentSession,
    TurnHandlingOptions,
    inference,
    llm as llm_api,
    stt as stt_api,
    tts as tts_api,
    vad as vad_api,
)
from livekit.plugins import sarvam, silero

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.pipeline.realtime_stt import RealtimeSTT


def load_vad(config: AgentConfigModel) -> silero.VAD:
    return silero.VAD.load(**_vad_options(config))


def apply_vad_options(vad: silero.VAD, config: AgentConfigModel) -> None:
    """The prewarmed VAD carries default settings; each call applies its own. Safe only
    because every call runs in its own process (see entrypoint.build_server)."""
    vad.update_options(**_vad_options(config))


def _vad_options(config: AgentConfigModel) -> dict[str, float]:
    return {
        "min_speech_duration": config.vad_min_speech,
        "min_silence_duration": config.vad_min_silence,
        "prefix_padding_duration": config.vad_prefix_padding,
        "activation_threshold": config.vad_activation_threshold,
    }


def build_session(config: AgentConfigModel, vad: vad_api.VAD) -> AgentSession:
    min_delay, max_delay = config.effective_endpointing_delays
    turn_handling: TurnHandlingOptions = {
        "endpointing": {"mode": "dynamic", "min_delay": min_delay, "max_delay": max_delay},
        "turn_detection": inference.TurnDetector() if config.use_turn_detector else "vad",
    }
    return AgentSession(
        stt=build_stt(config),
        llm=build_llm(config),
        tts=build_tts(config),
        vad=vad,
        turn_handling=turn_handling,
        # Silence on both sides this long marks the caller "away"; see call_tools/silence.py.
        user_away_timeout=config.silence_timeout,
    )


def build_stt(config: AgentConfigModel) -> stt_api.STT:
    speech_to_text: stt_api.STT = (
        RealtimeSTT(model=config.stt_model, language=config.stt_language, mode=config.stt_mode)
        if config.stt_realtime
        else sarvam.STT(model=config.stt_model, mode=config.stt_mode, language=config.stt_language)
    )
    if config.fallback_stt:
        speech_to_text = stt_api.FallbackAdapter(
            [
                speech_to_text,
                inference.STT(
                    model=config.fallback_stt, language=_base_language(config.stt_language)
                ),
            ]
        )
    return speech_to_text


def build_llm(config: AgentConfigModel) -> llm_api.LLM:
    options: dict[str, Any] = {}
    if config.llm_temperature is not None:
        options["temperature"] = config.llm_temperature
    # Capping reply length caps TTS, the largest line item of a call.
    if config.max_response_tokens is not None:
        options["max_tokens"] = config.max_response_tokens
    language_model: llm_api.LLM = sarvam.LLM(model=config.llm_model, **options)
    if config.fallback_llm:
        language_model = llm_api.FallbackAdapter(
            [language_model, inference.LLM(model=config.fallback_llm)]
        )
    return language_model


def build_analysis_llm(config: AgentConfigModel) -> llm_api.LLM:
    """The call's own model, deterministic, for the post-call analysis."""
    return sarvam.LLM(model=config.llm_model, temperature=0.0)


def build_tts(config: AgentConfigModel) -> tts_api.TTS:
    text_to_speech: tts_api.TTS = sarvam.TTS(
        model=config.tts_model,
        speaker=config.tts_speaker,
        target_language_code=config.tts_language,
        pace=config.tts_pace,
        # Raw PCM at Sarvam's highest streaming rate. The plugin's default MP3 is decoded
        # and re-encoded (Opus for browsers, G.711 for phones) and the two lossy passes
        # are audible; PCM also reaches first audio slightly sooner.
        output_audio_codec="linear16",
        speech_sample_rate=24000,
    )
    if config.fallback_tts:
        fallback_options: dict[str, Any] = {"language": _base_language(config.tts_language)}
        if config.fallback_tts_voice:
            fallback_options["voice"] = config.fallback_tts_voice
        text_to_speech = tts_api.FallbackAdapter(
            [text_to_speech, inference.TTS(model=config.fallback_tts, **fallback_options)]
        )
    return text_to_speech


def _base_language(language: str) -> str:
    """ "hi-IN" to "hi": other providers name languages without the region."""
    return "multi" if language == "unknown" else language.split("-")[0]
