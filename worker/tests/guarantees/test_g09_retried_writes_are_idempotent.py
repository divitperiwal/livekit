"""Guarantee 9, worker half: every write carries its idempotency key, so a retry cannot
double-insert. The call record is keyed on the LiveKit job id; events on (call, seq), with
seq assigned by the worker when the event happens, never at send time. The API half
(unique constraints) is tested in the API."""

from automitra_worker.control_plane.contract import OpenCallRequest
from automitra_worker.reporting.event_buffer import EventBuffer


class FlakySink:
    """Fails the first write, then succeeds; remembers every seq it was sent."""

    def __init__(self) -> None:
        self.attempts = 0
        self.sent_seqs: list[list[int]] = []

    async def append_events(self, call_id, org_id, events):
        self.attempts += 1
        self.sent_seqs.append([event.seq for event in events])
        return None if self.attempts == 1 else object()


async def test_event_sequence_numbers_are_fixed_when_the_event_happens():
    sink = FlakySink()
    buffer = EventBuffer(sink, call_id="call-1", org_id="org-kbs")
    buffer.add({"type": "user_message", "role": "user", "content": "a"})
    await buffer.flush()  # fails
    buffer.add({"type": "agent_message", "role": "assistant", "content": "b"})
    await buffer.flush()
    # Numbers are never reused, so the API's unique (call, seq) makes any resend a no-op.
    flattened = [seq for batch in sink.sent_seqs for seq in batch]
    assert flattened == [1, 2]


def test_the_call_record_is_keyed_on_the_livekit_job():
    request = OpenCallRequest(
        org_id="o",
        agent_id="a",
        agent_version_id="v",
        lk_room_name="r",
        lk_job_id="job-42",
        direction="inbound",
    )
    assert request.model_dump(by_alias=True)["lkJobId"] == "job-42"
    assert OpenCallRequest.model_fields["lk_job_id"].is_required()
