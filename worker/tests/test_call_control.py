"""The built-in call-control tools, and reading a failed dial.

The dial classification decides whether a contact is tried again, so getting
it wrong is either a missed customer or a number called over and over.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from livekit import api
from livekit.agents.llm import ChatMessage
from livekit.api.twirp_client import SipCallError

from automitra_worker.agent_config_model import AgentConfigModel, ClosingLine, TransferTarget
from automitra_worker.call_control import (
    END_CALL_RESULT,
    CallOutcome,
    Closing,
    classify_dial_failure,
    closing_line_for,
    close_after_goodbye,
    end_call_tool,
    said_something,
    suppress_end_call_reply,
    transfer_tool,
)


def sip_error(code: int) -> SipCallError:
    return SipCallError(
        "unavailable", "call failed", status=503, metadata={"sip_status_code": str(code)}
    )


@pytest.mark.parametrize(
    ("code", "status"),
    [
        (486, "busy"),
        (600, "busy"),
        (603, "busy"),
        (408, "no_answer"),
        (480, "no_answer"),
        (487, "no_answer"),
        (404, "failed"),
        (484, "failed"),
        (503, "failed"),
    ],
)
def test_sip_codes(code: int, status: str) -> None:
    assert classify_dial_failure(sip_error(code)) == (status, f"sip_{code}")


def test_a_ring_timeout_is_no_answer() -> None:
    exc = api.TwirpError(api.TwirpErrorCode.DEADLINE_EXCEEDED, "timed out", status=504)
    assert classify_dial_failure(exc) == ("no_answer", "ring_timeout")


def test_anything_else_is_a_failure() -> None:
    assert classify_dial_failure(RuntimeError("no trunk")) == ("failed", "dial_error")


def test_an_outcome_starts_as_an_ordinary_answered_call() -> None:
    outcome = CallOutcome()
    assert (outcome.status, outcome.answered, outcome.do_not_call) == ("completed", True, False)


def test_end_call_offers_a_do_not_call_flag() -> None:
    schema = end_call_tool(CallOutcome()).info.raw_schema
    assert schema["name"] == "end_call"
    assert schema["parameters"]["properties"]["do_not_call"]["type"] == "boolean"


class FakeHandle:
    def __init__(self, *said: str) -> None:
        self.chat_items = [ChatMessage(role="assistant", content=[text]) for text in said]
        self.callbacks: list = []

    def add_done_callback(self, callback) -> None:
        self.callbacks.append(callback)


class FakeSession:
    def __init__(self) -> None:
        self.replies: list[dict] = []
        self.said: list[str] = []
        self.closed = False

    async def _reply(self) -> None:
        return None

    def generate_reply(self, **kwargs):
        self.replies.append(kwargs)
        return self._reply()

    def say(self, text: str, **kwargs):
        self.said.append(text)
        return self._reply()

    def shutdown(self) -> None:
        self.closed = True


def run_end_call(
    outcome: CallOutcome,
    handle: FakeHandle,
    session: FakeSession,
    closing: Closing | None = None,
    **arguments,
):
    context = SimpleNamespace(speech_handle=handle, session=session)
    return asyncio.run(end_call_tool(outcome, closing)(arguments, context))


def test_end_call_answers_with_text() -> None:
    # Sarvam rejects every later request in a call whose history holds a tool
    # message with empty content, so the result must never be empty.
    outcome, handle = CallOutcome(), FakeHandle("धन्यवाद, अलविदा।")
    assert run_end_call(outcome, handle, FakeSession()) == END_CALL_RESULT
    assert outcome.end_reason == "agent_ended"


class FakeExecuted:
    def __init__(self, *names: str) -> None:
        self.function_calls = [SimpleNamespace(name=name) for name in names]
        self.cancelled = False

    def cancel_tool_reply(self) -> None:
        self.cancelled = True


def test_end_call_asks_for_no_reply() -> None:
    # A reply was what made the model call end_call again, up to the tool-step
    # limit: three extra model requests on every call that ended this way.
    ev = FakeExecuted("end_call")
    suppress_end_call_reply(ev)
    assert ev.cancelled


def test_other_tools_still_get_their_reply() -> None:
    for names in (("lookup_booking",), ("lookup_booking", "end_call"), ()):
        ev = FakeExecuted(*names)
        suppress_end_call_reply(ev)
        assert not ev.cancelled, names


def test_end_call_schedules_the_close_once() -> None:
    outcome, handle, session = CallOutcome(), FakeHandle("bye"), FakeSession()
    run_end_call(outcome, handle, session)
    run_end_call(outcome, handle, session)
    assert len(handle.callbacks) == 1


def test_end_call_still_records_do_not_call() -> None:
    outcome = CallOutcome()
    run_end_call(outcome, FakeHandle("bye"), FakeSession(), do_not_call=True)
    assert outcome.do_not_call


def test_a_goodbye_already_said_closes_without_another_request() -> None:
    session = FakeSession()
    asyncio.run(close_after_goodbye(session, FakeHandle("ठीक है, धन्यवाद।")))
    assert session.replies == [] and session.closed


def test_ending_without_a_word_asks_for_a_goodbye_first() -> None:
    session = FakeSession()
    asyncio.run(close_after_goodbye(session, FakeHandle()))
    assert len(session.replies) == 1 and session.replies[0]["tool_choice"] == "none"
    assert session.closed


def test_blank_text_is_not_a_goodbye() -> None:
    assert not said_something(FakeHandle("  "))
    assert said_something(FakeHandle("bye"))


def test_transfer_offers_exactly_the_configured_targets() -> None:
    targets = (
        TransferTarget(name="sales", number="+911100000001", description="Buying a car"),
        TransferTarget(name="service", number="+911100000002"),
    )
    tool = transfer_tool(
        targets,
        outcome=CallOutcome(),
        room_name=lambda: "room",
        phone_identity=lambda: None,
        lk=lambda: None,  # type: ignore[arg-type,return-value]
        on_transfer=lambda *_: None,
    )
    schema = tool.info.raw_schema
    assert schema["parameters"]["properties"]["target"]["enum"] == ["sales", "service"]
    assert "- sales: Buying a car" in schema["description"]


def test_transfer_targets_must_be_dialable() -> None:
    AgentConfigModel.model_validate({"transfer_targets": [{"name": "desk", "number": "+919876543210"}]})
    for number in ("9876543210", "+0123456789", "+91 98765 43210", "tel:+919876543210"):
        with pytest.raises(ValueError):
            AgentConfigModel.model_validate(
                {"transfer_targets": [{"name": "desk", "number": number}]}
            )


def test_voicemail_action_is_one_of_two() -> None:
    AgentConfigModel.model_validate({"voicemail_action": "leave_message"})
    with pytest.raises(ValueError):
        AgentConfigModel.model_validate({"voicemail_action": "sing"})


# --- closing lines -------------------------------------------------------------

DAY = ClosingLine(start=9, end=18, text="ठीक है {{caller_name}} जी, दस से पंद्रह मिनट में call आ जाएगा।")
EARLY = ClosingLine(start=0, end=9, text="ठीक है {{caller_name}} जी, आज सुबह nine बजे के बाद call आएगा।")
EVENING = ClosingLine(start=18, end=24, text="ठीक है {{caller_name}} जी, कल सुबह nine बजे के बाद call आएगा।")
KOLKATA = ZoneInfo("Asia/Kolkata")


def at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 9, 28, hour, minute, tzinfo=KOLKATA)


@pytest.mark.parametrize(
    ("hour", "expected"),
    [(0, EARLY), (6, EARLY), (8, EARLY), (9, DAY), (13, DAY), (17, DAY), (18, EVENING), (23, EVENING)],
)
def test_the_hour_picks_the_line(hour: int, expected: ClosingLine) -> None:
    # The boundaries are where the prompt-only version went wrong: a 6:30 AM
    # caller was told the team would call "tomorrow morning".
    assert closing_line_for((DAY, EARLY, EVENING), hour) is expected


def test_a_line_can_run_through_midnight() -> None:
    night = ClosingLine(start=18, end=9, text="night")
    assert [closing_line_for((DAY, night), h) is night for h in (18, 23, 0, 8, 9)] == [
        True, True, True, True, False,
    ]


def test_equal_hours_cover_the_whole_day_and_the_first_match_wins() -> None:
    always = ClosingLine(start=0, end=0, text="always")
    assert closing_line_for((always, DAY), 12) is always
    assert closing_line_for((DAY, always), 12) is DAY


def test_no_matching_hours_means_no_line() -> None:
    assert closing_line_for((DAY,), 20) is None


def test_the_line_carries_the_name_the_model_heard() -> None:
    closing = Closing((DAY, EARLY, EVENING), "Asia/Kolkata")
    assert closing.line("Rahul", now=at(20, 15)) == "ठीक है Rahul जी, कल सुबह nine बजे के बाद call आएगा।"


def test_a_missing_name_leaves_no_gap() -> None:
    closing = Closing((DAY,), "Asia/Kolkata")
    assert closing.line("  ", now=at(11)) == "ठीक है जी, दस से पंद्रह मिनट में call आ जाएगा।"


def test_the_hour_is_read_in_the_agents_timezone() -> None:
    # 14:00 UTC is 19:30 in Kolkata: the evening line, not the daytime one.
    closing = Closing((DAY, EARLY, EVENING), "Asia/Kolkata")
    utc = datetime(2026, 9, 28, 14, 0, tzinfo=ZoneInfo("UTC"))
    assert "कल सुबह" in closing.line("Amit", now=utc)


def test_a_call_variable_can_fill_the_name() -> None:
    closing = Closing((DAY,), "Asia/Kolkata", {"caller_name": "Neha"})
    assert closing.line("", now=at(11)).startswith("ठीक है Neha जी")
    assert closing.line("Rahul", now=at(11)).startswith("ठीक है Rahul जी")


def test_with_closing_lines_end_call_asks_for_the_name_and_no_goodbye() -> None:
    schema = end_call_tool(CallOutcome(), Closing((DAY,), "Asia/Kolkata")).info.raw_schema
    assert schema["parameters"]["properties"]["caller_name"]["type"] == "string"
    assert "do not say a goodbye" in schema["description"]
    plain = end_call_tool(CallOutcome()).info.raw_schema
    assert "caller_name" not in plain["parameters"]["properties"]


def test_the_closing_line_is_spoken_instead_of_a_model_goodbye() -> None:
    session = FakeSession()
    asyncio.run(close_after_goodbye(session, FakeHandle(), "ठीक है Rahul जी, धन्यवाद।"))
    assert session.said == ["ठीक है Rahul जी, धन्यवाद।"]
    assert session.replies == [] and session.closed


def test_end_call_closes_on_the_configured_line() -> None:
    outcome, handle, session = CallOutcome(), FakeHandle(), FakeSession()
    closing = Closing((ClosingLine(start=0, end=0, text="ठीक है {{caller_name}} जी, धन्यवाद।"),), "Asia/Kolkata")
    run_end_call(outcome, handle, session, closing, caller_name="Suresh")

    async def finish() -> None:
        handle.callbacks[0](handle)
        await asyncio.sleep(0)

    asyncio.run(finish())
    assert session.said == ["ठीक है Suresh जी, धन्यवाद।"] and session.closed
