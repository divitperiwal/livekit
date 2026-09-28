"""Sarvam's realtime speech-to-text, with each turn ended by the session's VAD.

The realtime endpoint streams partial transcripts as the caller speaks. Left
to its own voice detection it waits a long silence before it finalises -- about
a second and a half, measured, against 0.8 s on the streaming endpoint -- and a
short silence setting chops sentences at every pause.

Run with manual endpointing instead, it finalises as soon as it is told the
utterance is over. The session's own VAD already decides that, a quarter of a
second into the silence, so the call ends each utterance on that signal: the
final transcript then lands about 0.55 s after the caller stops, whole.

The endpoint runs ``saaras:v4`` as well as its own ``saaras:v3-realtime``, and
v4 is the one to use: on the same audio, v3-realtime wrote code-mixed speech
entirely in Devanagari ("एक्स यू वी थ्री एक्स ओ") where v4 kept "XUV3XO".
The plugin only admits v3-realtime, so the model is set on each stream before
it connects. Keyterms are not used: given a list of model names, v4 heard
"diesel automatic" as "XUV 3XO".

LiveKit does not flush an STT stream on end of speech itself, so this class
keeps its open streams and the call flushes them when the caller stops talking.
"""

from __future__ import annotations

import logging
import weakref
from typing import Any

from livekit.agents import stt as stt_api
from livekit.plugins import sarvam
from livekit.plugins.sarvam.stt_streaming import SUPPORTED_LANGUAGES, RealtimeSpeechStream

logger = logging.getLogger("automitra.realtime_stt")

# The realtime endpoint's name for each configured model.
REALTIME_MODELS = {"saaras:v4": "saaras:v4", "saaras:v3": "saaras:v3-realtime"}


def realtime_language(code: str) -> str:
    """The realtime endpoint's name for a language hint.

    It calls automatic detection "auto" where the batch models say "unknown",
    and accepts a shorter list. A hint it does not know falls back to
    detection rather than failing the call.
    """
    if code == "unknown":
        return "auto"
    if code in SUPPORTED_LANGUAGES:
        return code
    logger.warning("the realtime STT does not take %r; detecting the language instead", code)
    return "auto"


class RealtimeSTT(sarvam.STTRealtime):
    """Sarvam realtime STT whose utterances end when :meth:`end_of_speech` says."""

    def __init__(self, *, model: str, language: str, mode: str, **kwargs: Any) -> None:
        super().__init__(
            language=realtime_language(language),
            mode=mode,
            stream_type="fast",
            endpointing="manual",
            **kwargs,
        )
        # Set after construction: the plugin's options reject any model but
        # its own, and are only read again when a stream connects.
        self._opts.model = REALTIME_MODELS[model]
        self._open: weakref.WeakSet[RealtimeSpeechStream] = weakref.WeakSet()

    @property
    def model(self) -> str:
        # The plugin reports its own constant; metrics should name what runs.
        return self._opts.model

    def stream(self, **kwargs: Any) -> RealtimeSpeechStream:
        stream = super().stream(**kwargs)
        # Each stream builds its own options with the plugin's default model;
        # this runs before its connection task first does.
        stream._opts.model = self._opts.model
        self._open.add(stream)
        return stream

    def end_of_speech(self) -> None:
        """Finalise what the caller has said so far, on every open stream."""
        for stream in list(self._open):
            try:
                stream.flush()
            except RuntimeError:
                # Closed between the VAD firing and now; nothing to finalise.
                self._open.discard(stream)


def find_realtime_stt(component: stt_api.STT | None) -> RealtimeSTT | None:
    """The :class:`RealtimeSTT` in a session's STT, directly or behind a fallback."""
    if isinstance(component, RealtimeSTT):
        return component
    # FallbackAdapter keeps its providers in a private list; there is no
    # public accessor in this SDK version.
    for inner in getattr(component, "_stt_instances", ()):
        if isinstance(inner, RealtimeSTT):
            return inner
    return None
