"""Sarvam's realtime speech-to-text, with each utterance ended by the session's VAD.

Left to its own voice detection the realtime endpoint waits about 1.5 s of silence before
finalising. With manual endpointing it finalises when told to, and the session's VAD
already knows a quarter of a second into the silence: the final transcript lands about
0.55 s after the caller stops, whole.

`saaras:v4` is used rather than the plugin's own `saaras:v3-realtime`: on the same audio
v3-realtime wrote "XUV3XO" as "एक्स यू वी थ्री एक्स ओ". The plugin only admits its own
model, so the model is set on each stream before it connects.

LiveKit does not flush an STT stream on end of speech, so this class keeps its open
streams and the call flushes them when the caller stops talking.
"""

import logging
import weakref
from typing import Any

from livekit.agents import stt as stt_api
from livekit.plugins import sarvam
from livekit.plugins.sarvam.stt_streaming import SUPPORTED_LANGUAGES, RealtimeSpeechStream

logger = logging.getLogger("automitra.realtime_stt")

REALTIME_MODEL_BY_CONFIGURED_MODEL = {"saaras:v4": "saaras:v4", "saaras:v3": "saaras:v3-realtime"}


def realtime_language(language: str) -> str:
    """The realtime endpoint says "auto" where batch models say "unknown", and accepts
    fewer hints; an unknown hint falls back to detection rather than failing the call."""
    if language == "unknown":
        return "auto"
    if language in SUPPORTED_LANGUAGES:
        return language
    logger.warning("the realtime STT does not take %r; detecting the language instead", language)
    return "auto"


class RealtimeSTT(sarvam.STTRealtime):
    def __init__(self, *, model: str, language: str, mode: str, **kwargs: Any) -> None:
        super().__init__(
            language=realtime_language(language),
            mode=mode,
            stream_type="fast",
            endpointing="manual",
            **kwargs,
        )
        # Set after construction: the plugin's options reject any model but its own,
        # and only read it again when a stream connects.
        self._opts.model = REALTIME_MODEL_BY_CONFIGURED_MODEL[model]
        self._open_streams: weakref.WeakSet[RealtimeSpeechStream] = weakref.WeakSet()

    @property
    def model(self) -> str:
        return self._opts.model

    def stream(self, **kwargs: Any) -> RealtimeSpeechStream:
        stream = super().stream(**kwargs)
        stream._opts.model = self._opts.model
        self._open_streams.add(stream)
        return stream

    def end_of_speech(self) -> None:
        """Finalise what the caller has said so far, on every open stream."""
        for stream in list(self._open_streams):
            try:
                stream.flush()
            except RuntimeError:
                self._open_streams.discard(stream)


def find_realtime_stt(component: stt_api.STT | None) -> RealtimeSTT | None:
    """Directly, or behind a FallbackAdapter (which has no public accessor for its STTs)."""
    if isinstance(component, RealtimeSTT):
        return component
    for inner in getattr(component, "_stt_instances", ()):
        if isinstance(inner, RealtimeSTT):
            return inner
    return None
