import asyncio

import pytest

from automitra_worker.control_plane.contract import AppendEventsResponse
from automitra_worker.reporting import event_buffer
from automitra_worker.reporting.event_buffer import MAX_BUFFERED_EVENTS, EventBuffer


class RecordingSink:
    def __init__(self, *, fail: bool = False, raise_error: bool = False) -> None:
        self.batches: list[list] = []
        self.fail = fail
        self.raise_error = raise_error

    async def append_events(self, call_id, org_id, events):
        if self.raise_error:
            raise RuntimeError("boom")
        self.batches.append(events)
        return None if self.fail else AppendEventsResponse(inserted=len(events))


def turn(text: str = "नमस्ते") -> dict:
    return {"type": "user_message", "role": "user", "content": text, "payload": {}}


def buffer_for(sink, **options) -> EventBuffer:
    return EventBuffer(sink, call_id="call-1", org_id="org-kbs", **options)


async def test_events_are_numbered_from_one_and_carry_a_timestamp():
    sink = RecordingSink()
    buffer = buffer_for(sink)
    buffer.add(turn("a"))
    buffer.add(turn("b"))
    await buffer.flush()
    assert [event.seq for event in sink.batches[0]] == [1, 2]
    assert all(event.at for event in sink.batches[0])


async def test_numbering_continues_across_flushes():
    sink = RecordingSink()
    buffer = buffer_for(sink)
    buffer.add(turn())
    await buffer.flush()
    buffer.add(turn())
    await buffer.flush()
    assert [batch[0].seq for batch in sink.batches] == [1, 2]


async def test_nothing_to_flush_means_no_request_and_none_rows_are_ignored():
    sink = RecordingSink()
    buffer = buffer_for(sink)
    buffer.add(None)
    await buffer.flush()
    assert sink.batches == []


async def test_a_failed_batch_is_counted_dropped_and_not_retried_forever():
    sink = RecordingSink(fail=True)
    buffer = buffer_for(sink)
    buffer.add(turn())
    await buffer.flush()
    await buffer.flush()
    assert len(sink.batches) == 1 and buffer.dropped == 1


async def test_a_raising_sink_does_not_raise_out_of_flush():
    buffer = buffer_for(RecordingSink(raise_error=True))
    buffer.add(turn())
    await buffer.flush()
    assert buffer.dropped == 1


async def test_the_buffer_is_bounded_and_drops_the_oldest():
    sink = RecordingSink()
    buffer = buffer_for(sink)
    for index in range(MAX_BUFFERED_EVENTS + 10):
        buffer.add(turn(str(index)))
    await buffer.flush()
    kept = sink.batches[0]
    assert len(kept) == MAX_BUFFERED_EVENTS and kept[0].seq == 11 and buffer.dropped == 10


async def test_closing_writes_what_is_left_and_ignores_later_events():
    sink = RecordingSink()
    buffer = buffer_for(sink)
    buffer.start()
    buffer.add(turn())
    await buffer.aclose()
    buffer.add(turn())
    await buffer.flush()
    assert [len(batch) for batch in sink.batches] == [1]


async def test_the_background_task_flushes_on_its_own():
    sink = RecordingSink()
    buffer = buffer_for(sink, flush_interval_seconds=0.01)
    buffer.start()
    buffer.add(turn())
    await asyncio.sleep(0.05)
    assert sink.batches
    await buffer.aclose()


async def test_a_full_batch_flushes_before_the_interval(monkeypatch):
    monkeypatch.setattr(event_buffer, "FLUSH_AT_EVENTS", 3)
    sink = RecordingSink()
    buffer = buffer_for(sink, flush_interval_seconds=60)
    buffer.start()
    for _ in range(3):
        buffer.add(turn())
    await asyncio.sleep(0.02)
    assert len(sink.batches) == 1
    await buffer.aclose()


async def test_the_background_loop_survives_a_raising_sink():
    sink = RecordingSink(raise_error=True)
    buffer = buffer_for(sink, flush_interval_seconds=0.01)
    buffer.start()
    buffer.add(turn())
    await asyncio.sleep(0.03)
    sink.raise_error = False
    buffer.add(turn())
    await asyncio.sleep(0.03)
    assert sink.batches
    await buffer.aclose()


def test_add_never_awaits():
    """Called from session handlers on the audio loop: it must not need a running loop."""
    buffer = buffer_for(RecordingSink())
    buffer.add(turn())
    assert buffer.dropped == 0
