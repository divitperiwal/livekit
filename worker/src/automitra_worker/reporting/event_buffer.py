"""Recording what happened on a call without getting in its way.

Session event handlers run on the loop that carries audio, so `add` only appends and
returns; a background task flushes every 2 s, or sooner once 20 events wait. The buffer
is capped at 500: past that the control plane is down, and the oldest events are dropped
with a warning rather than growing until the process runs out of memory.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime
from typing import Any, Protocol

from automitra_worker.control_plane.contract import AppendEventsResponse, CallEvent

logger = logging.getLogger("automitra.event_buffer")

FLUSH_INTERVAL_SECONDS = 2.0
FLUSH_AT_EVENTS = 20
MAX_BUFFERED_EVENTS = 500


class EventSink(Protocol):
    async def append_events(
        self, call_id: str, org_id: str, events: list[CallEvent]
    ) -> AppendEventsResponse | None: ...


class EventBuffer:
    def __init__(
        self,
        sink: EventSink,
        *,
        call_id: str,
        org_id: str,
        flush_interval_seconds: float = FLUSH_INTERVAL_SECONDS,
    ) -> None:
        self._sink = sink
        self.call_id = call_id
        self.org_id = org_id
        self._flush_interval_seconds = flush_interval_seconds
        self._events: list[CallEvent] = []
        self._next_seq = 1
        self.dropped = 0
        self._flusher: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._closed = False

    def start(self) -> None:
        if self._flusher is None:
            self._flusher = asyncio.create_task(self._flush_periodically())

    def add(self, row: dict[str, Any] | None) -> None:
        """Synchronous and non-blocking. The sequence number is assigned here, not by the
        API, so a retried flush carries the same numbers and inserts nothing twice."""
        if self._closed or row is None:
            return
        self._events.append(CallEvent(seq=self._next_seq, at=datetime.now(UTC).isoformat(), **row))
        self._next_seq += 1

        overflow = len(self._events) - MAX_BUFFERED_EVENTS
        if overflow > 0:
            if self.dropped == 0:
                logger.warning(
                    "call %s: event buffer full, dropping the oldest; the control plane is "
                    "probably unreachable",
                    self.call_id,
                )
            del self._events[:overflow]
            self.dropped += overflow

        if len(self._events) >= FLUSH_AT_EVENTS:
            self._wake.set()

    async def flush(self) -> None:
        """Never raises: this runs on the shutdown path too, and an exception there would
        take the call's finalisation, and so its usage record, down with it.

        A failed batch is not put back: retrying it forever would keep a dead control
        plane from ever draining the buffer."""
        if not self._events:
            return
        batch, self._events = self._events, []
        try:
            written = await self._sink.append_events(self.call_id, self.org_id, batch)
        except Exception:
            logger.exception("call %s: could not write %d events", self.call_id, len(batch))
            written = None
        if written is None:
            self.dropped += len(batch)

    async def aclose(self) -> None:
        """Stop the flusher and write what is left."""
        self._closed = True
        if self._flusher is not None:
            self._flusher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._flusher
            self._flusher = None
        await self.flush()
        if self.dropped:
            logger.warning("call %s: %d events were not written", self.call_id, self.dropped)

    async def _flush_periodically(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), self._flush_interval_seconds)
            self._wake.clear()
            try:
                await self.flush()
            except Exception:
                logger.exception("call %s: flush failed", self.call_id)
