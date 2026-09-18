"""Recording what happened on a call, without getting in its way.

The session's event handlers run on the loop that is also carrying audio.
Awaiting a network write inside one of them would put that latency directly
into the conversation, so nothing here does any I/O on the calling thread:
``add`` appends to a list and returns, and a background task flushes.

The buffer is bounded. If the control plane is unreachable the events pile up,
and past the cap the oldest are dropped with a warning rather than growing
until the process runs out of memory. A transcript is worth a great deal, but
not a dropped call -- and the canonical copy is written from the session's own
history at the end, so a dropped batch loses the live view rather than the
record.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .control_plane import ControlPlane

logger = logging.getLogger("automitra.call_writer")

# How often the background task drains the buffer. Short enough that the
# dashboard shows a call roughly as it happens, long enough that a busy call
# is a handful of requests rather than one per turn.
FLUSH_INTERVAL_SECONDS = 2.0

# Flush early once this many events are waiting, so a fast exchange does not
# sit in memory for the whole interval.
FLUSH_AT = 20

# Past this, the oldest events are dropped. Roughly an hour of dense
# conversation, which means reaching it indicates the control plane is down
# rather than that the call is long.
MAX_BUFFERED = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CallWriter:
    """Buffers call events and flushes them in the background."""

    control_plane: ControlPlane
    call_id: str
    org_id: str

    _buffer: list[dict[str, Any]] = field(default_factory=list, init=False)
    _seq: int = field(default=0, init=False)
    _dropped: int = field(default=0, init=False)
    _task: asyncio.Task[None] | None = field(default=None, init=False)
    _wake: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    _closed: bool = field(default=False, init=False)

    def start(self) -> None:
        """Begin flushing in the background."""
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    def add(
        self,
        event_type: str,
        *,
        role: str | None = None,
        content: str | None = None,
        payload: dict[str, Any] | None = None,
        at: str | None = None,
    ) -> None:
        """Record an event. Synchronous and non-blocking, by design.

        The sequence number is assigned here rather than by the control plane,
        so a flush that is retried after a network failure carries the same
        numbers and inserts nothing the second time.
        """
        if self._closed:
            return

        self._seq += 1
        self._buffer.append(
            {
                "seq": self._seq,
                "type": event_type,
                "role": role,
                "content": content,
                "payload": payload or {},
                "at": at or _now(),
            }
        )

        if len(self._buffer) > MAX_BUFFERED:
            # Drop the oldest: the recent past is what someone watching a live
            # call needs, and the full record is written from session history
            # at the end regardless.
            overflow = len(self._buffer) - MAX_BUFFERED
            del self._buffer[:overflow]
            self._dropped += overflow
            if self._dropped == overflow:  # only on the first drop
                logger.warning(
                    "call %s: event buffer is full, dropping the oldest. The "
                    "control plane is probably unreachable.",
                    self.call_id,
                )

        if len(self._buffer) >= FLUSH_AT:
            self._wake.set()

    async def flush(self) -> None:
        """Write whatever is buffered. Failures are logged, never raised.

        Never raising is the contract, not an implementation detail. This runs
        from the shutdown path as well as the background task, and an exception
        escaping there would take the call's finalisation -- and so its usage
        record -- down with the transcript.
        """
        if not self._buffer:
            return

        batch = self._buffer[:]
        self._buffer.clear()

        try:
            result = await self.control_plane.append_events(
                self.call_id, self.org_id, batch
            )
        except Exception:
            logger.exception("call %s: could not write %d events", self.call_id, len(batch))
            result = None

        if result is None:
            # The write failed and was already logged by the client. The events
            # are gone from the buffer deliberately: putting them back would
            # keep a dead control plane from ever draining, and retrying the
            # same batch forever is how a buffer becomes an outage.
            self._dropped += len(batch)

    async def aclose(self) -> None:
        """Stop flushing and write what is left."""
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self.flush()
        if self._dropped:
            logger.warning(
                "call %s: %d events were not written", self.call_id, self._dropped
            )

    async def _run(self) -> None:
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), FLUSH_INTERVAL_SECONDS)
            self._wake.clear()
            try:
                await self.flush()
            except Exception:
                # The loop must survive anything: it is the only thing draining
                # the buffer, and stopping it silently would make every later
                # event a drop.
                logger.exception("call %s: flush failed", self.call_id)
