"""Sarvam answering 429: a plan limit was hit. The plugin retries, and meanwhile the caller
hears silence, so every one is an alert (docs/runbooks/sarvam-rate-limited.md)."""

import logging
from typing import Any, Protocol

from livekit.agents import APIStatusError

logger = logging.getLogger("automitra.sarvam")

ALERT_NAME = "sarvam-rate-limited"


class EmitsErrors(Protocol):
    def on(self, event: str, callback: Any = None) -> Any: ...


def alert_on_rate_limits[Service: EmitsErrors](service: Service) -> Service:
    """Watches one Sarvam STT, LLM or TTS. Attached to the Sarvam object itself, not the
    session: a fallback adapter keeps its primary's errors from the session."""
    service.on("error", _alert_if_rate_limited)
    return service


def is_rate_limited(error: BaseException | None) -> bool:
    """The plugins wrap some failures (a WebSocket session's) in a new error, so the
    causes are searched too."""
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, APIStatusError) and error.status_code == 429:
            return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


def _alert_if_rate_limited(event: Any) -> None:
    if not is_rate_limited(getattr(event, "error", None)):
        return
    retrying = "retrying" if getattr(event, "recoverable", False) else "gave up"
    logger.error(
        "ALERT %s: Sarvam %s answered 429 (%s); the caller hears silence meanwhile",
        ALERT_NAME,
        getattr(event, "label", "service"),
        retrying,
    )
