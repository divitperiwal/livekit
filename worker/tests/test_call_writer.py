"""Buffering call events without getting in the call's way.

The properties worth holding: ``add`` never blocks, a failing control plane
cannot grow the buffer without bound, and nothing here ever raises into a
session event handler.
"""

from __future__ import annotations

import asyncio

import pytest

from automitra_worker import call_writer
from automitra_worker.call_writer import MAX_BUFFERED, CallWriter


class FakePlane:
    """Records what was written, and can be made to fail."""

    def __init__(self, *, fail: bool = False, slow: float = 0.0) -> None:
        self.fail = fail
        self.slow = slow
        self.batches: list[list[dict]] = []

    async def append_events(
        self, call_id: str, org_id: str, events: list[dict]
    ) -> dict | None:
        if self.slow:
            await asyncio.sleep(self.slow)
        if self.fail:
            return None  # the client logs and returns None on failure
        self.batches.append(events)
        return {"written": len(events)}

    @property
    def written(self) -> list[dict]:
        return [event for batch in self.batches for event in batch]


def writer(plane: FakePlane) -> CallWriter:
    return CallWriter(control_plane=plane, call_id="call-1", org_id="org-1")


# --- sequencing -------------------------------------------------------------


async def test_events_are_numbered_from_one() -> None:
    """The worker assigns the sequence, not the control plane.

    That is what makes a retried flush idempotent: the same events carry the
    same numbers and the second insert does nothing.
    """
    plane = FakePlane()
    w = writer(plane)
    w.add("user_message", content="one")
    w.add("agent_message", content="two")
    await w.flush()

    assert [event["seq"] for event in plane.written] == [1, 2]


async def test_sequence_continues_across_flushes() -> None:
    plane = FakePlane()
    w = writer(plane)
    w.add("user_message", content="one")
    await w.flush()
    w.add("user_message", content="two")
    await w.flush()

    assert [event["seq"] for event in plane.written] == [1, 2]


async def test_every_event_carries_a_timestamp() -> None:
    plane = FakePlane()
    w = writer(plane)
    w.add("user_message", content="hello")
    await w.flush()
    assert plane.written[0]["at"]


# --- not getting in the way -------------------------------------------------


async def test_add_does_not_block_on_a_slow_control_plane() -> None:
    """``add`` runs on the loop carrying audio. It must return immediately."""
    plane = FakePlane(slow=0.5)
    w = writer(plane)

    started = asyncio.get_running_loop().time()
    for index in range(50):
        w.add("user_message", content=str(index))
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 0.05, "add() waited on something"


async def test_flushing_nothing_does_not_call_out() -> None:
    plane = FakePlane()
    await writer(plane).flush()
    assert plane.batches == []


# --- failure --------------------------------------------------------------


async def test_a_failed_write_does_not_raise() -> None:
    """A call must not break because a transcript could not be stored."""
    plane = FakePlane(fail=True)
    w = writer(plane)
    w.add("user_message", content="hello")
    await w.flush()  # must not raise


async def test_the_buffer_is_bounded_when_writes_fail() -> None:
    """Otherwise a dead control plane is a memory leak on every live call."""
    plane = FakePlane(fail=True)
    w = writer(plane)
    for index in range(MAX_BUFFERED + 250):
        w.add("user_message", content=str(index))

    assert len(w._buffer) <= MAX_BUFFERED


async def test_the_oldest_events_are_the_ones_dropped() -> None:
    """Someone watching a live call needs the recent past, not the start.

    The full record is written from session history at the end regardless, so
    this loses the live view rather than the transcript.
    """
    plane = FakePlane()
    w = writer(plane)
    for index in range(MAX_BUFFERED + 10):
        w.add("user_message", content=f"turn-{index}")

    contents = [event["content"] for event in w._buffer]
    assert contents[-1] == f"turn-{MAX_BUFFERED + 9}"
    assert "turn-0" not in contents


async def test_a_failed_batch_is_not_retried_forever() -> None:
    """Re-queueing a failed batch would stop a dead plane ever draining."""
    plane = FakePlane(fail=True)
    w = writer(plane)
    w.add("user_message", content="hello")
    await w.flush()
    assert w._buffer == []


# --- lifecycle --------------------------------------------------------------


async def test_closing_writes_what_is_left() -> None:
    plane = FakePlane()
    w = writer(plane)
    w.start()
    w.add("user_message", content="last words")
    await w.aclose()

    assert [event["content"] for event in plane.written] == ["last words"]


async def test_closing_stops_the_background_task() -> None:
    plane = FakePlane()
    w = writer(plane)
    w.start()
    await w.aclose()
    assert w._task is None


async def test_events_after_close_are_ignored() -> None:
    plane = FakePlane()
    w = writer(plane)
    w.start()
    await w.aclose()
    w.add("user_message", content="too late")
    assert w._buffer == []


async def test_the_background_task_flushes_on_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(call_writer, "FLUSH_INTERVAL_SECONDS", 0.05)
    plane = FakePlane()
    w = writer(plane)
    w.start()
    try:
        w.add("user_message", content="written without an explicit flush")
        await asyncio.sleep(0.2)
        assert plane.written, "the background task never flushed"
    finally:
        await w.aclose()


async def test_a_full_batch_flushes_early(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fast exchange should not sit in memory for the whole interval."""
    monkeypatch.setattr(call_writer, "FLUSH_INTERVAL_SECONDS", 60.0)
    plane = FakePlane()
    w = writer(plane)
    w.start()
    try:
        for index in range(call_writer.FLUSH_AT):
            w.add("user_message", content=str(index))
        await asyncio.sleep(0.1)
        assert plane.written, "a full batch waited for the timer"
    finally:
        await w.aclose()


async def test_a_raising_control_plane_does_not_kill_the_loop() -> None:
    """The loop is the only thing draining the buffer.

    If it dies quietly, every later event is a silent drop.
    """

    class Exploding(FakePlane):
        async def append_events(self, *args, **kwargs):  # type: ignore[override]
            raise RuntimeError("boom")

    plane = Exploding()
    w = writer(plane)
    w.start()
    w.add("user_message", content="one")
    await asyncio.sleep(0.05)
    assert w._task is not None and not w._task.done()

    # And closing must not raise either: it runs in the shutdown path, where
    # an exception would take the call's finalisation down with the transcript.
    await w.aclose()
