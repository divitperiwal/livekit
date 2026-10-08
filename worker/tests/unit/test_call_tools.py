import asyncio
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from livekit.agents.llm import ChatMessage, StopResponse, ToolError

from automitra_worker.agent_config.model import ClosingLine, TransferTarget
from automitra_worker.agent_config.personas import get_persona
from automitra_worker.call_tools.end_call import (
    END_CALL_RESULT,
    Closing,
    close_after_goodbye,
    closing_line_for,
    end_call_tool,
    said_something,
    suppress_end_call_reply,
)
from automitra_worker.call_tools.keypad import KeypadInput, keypad_message
from automitra_worker.call_tools.silence import SilenceAction, SilenceWatch
from automitra_worker.call_tools.transfer import TRANSFERRED, transfer_tool
from automitra_worker.reporting.call_outcome import CallOutcome

MORNING = ClosingLine(start=5, end=12, text="आपका दिन शुभ हो {{caller_name}} जी।")
EVENING = ClosingLine(start=12, end=22, text="शुभ संध्या {{caller_name}} जी।")
NIGHT = ClosingLine(start=22, end=5, text="शुभ रात्रि।")


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

    async def _done(self) -> None:
        return None

    def generate_reply(self, **options):
        self.replies.append(options)
        return self._done()

    def say(self, text: str, **options):
        self.said.append(text)
        return self._done()

    def shutdown(self) -> None:
        self.closed = True


async def run_end_call(outcome, handle, session, closing=None, **arguments):
    return await end_call_tool(outcome, closing)(
        arguments, SimpleNamespace(speech_handle=handle, session=session)
    )


@pytest.mark.parametrize(
    ("hour", "expected"),
    [(5, MORNING), (11, MORNING), (12, EVENING), (21, EVENING), (22, NIGHT), (3, NIGHT)],
)
def test_the_hour_picks_the_line_including_through_midnight(hour, expected):
    assert closing_line_for([MORNING, EVENING, NIGHT], hour) == expected


def test_equal_hours_cover_the_day_and_the_first_match_wins_and_gaps_give_none():
    all_day = ClosingLine(start=0, end=0, text="नमस्ते।")
    assert closing_line_for([all_day, MORNING], 9) == all_day
    assert closing_line_for([MORNING], 15) is None


def test_the_kbs_closing_lines_cover_every_hour():
    lines = get_persona("kbs").closing_lines
    assert all(closing_line_for(lines, hour) is not None for hour in range(24))


def test_the_closing_line_carries_the_name_and_leaves_no_gap_without_one():
    closing = Closing((EVENING,), "Asia/Kolkata")
    six_pm = datetime(2026, 10, 4, 18, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
    assert closing.line("Asha", now=six_pm) == "शुभ संध्या Asha जी।"
    assert closing.line("", now=six_pm) == "शुभ संध्या जी।"
    assert (
        Closing((EVENING,), "Asia/Kolkata", {"caller_name": "Ravi"}).line("", now=six_pm)
        == "शुभ संध्या Ravi जी।"
    )


def test_the_hour_is_read_in_the_agents_timezone():
    noon_utc = datetime(2026, 10, 4, 6, 0, tzinfo=ZoneInfo("UTC"))  # 11:30 in India
    assert Closing((MORNING, EVENING), "Asia/Kolkata").line("", now=noon_utc).startswith("आपका दिन")


async def test_end_call_records_do_not_call_and_closes_once_after_the_turn():
    outcome, handle, session = CallOutcome(), FakeHandle("ठीक है, नमस्ते।"), FakeSession()
    assert await run_end_call(outcome, handle, session, do_not_call=True) == END_CALL_RESULT
    assert await run_end_call(outcome, handle, session) == END_CALL_RESULT
    assert outcome.do_not_call and outcome.end_reason == "agent_ended"
    assert len(handle.callbacks) == 1


def test_end_call_offers_a_caller_name_only_with_closing_lines():
    plain = end_call_tool(CallOutcome()).info.raw_schema
    with_closing = end_call_tool(CallOutcome(), Closing((EVENING,), "Asia/Kolkata")).info.raw_schema
    assert "caller_name" not in plain["parameters"]["properties"]
    assert "caller_name" in with_closing["parameters"]["properties"]
    assert "spoken for you" in with_closing["description"]


async def test_a_goodbye_already_said_closes_without_another_request():
    session = FakeSession()
    await close_after_goodbye(session, FakeHandle("धन्यवाद, नमस्ते।"), None)
    assert session.replies == [] and session.closed


async def test_ending_without_a_word_asks_for_a_goodbye_first():
    session = FakeSession()
    await close_after_goodbye(session, FakeHandle("   "), None)
    assert len(session.replies) == 1 and session.closed
    assert not said_something(FakeHandle("  "))


async def test_a_closing_line_is_spoken_as_written_instead():
    session = FakeSession()
    await close_after_goodbye(session, FakeHandle("ok"), "शुभ संध्या।")
    assert session.said == ["शुभ संध्या।"] and session.replies == []


def test_only_an_end_call_turn_has_its_reply_suppressed():
    cancelled = []
    end_only = SimpleNamespace(
        function_calls=[SimpleNamespace(name="end_call")],
        cancel_tool_reply=lambda: cancelled.append(1),
    )
    mixed = SimpleNamespace(
        function_calls=[SimpleNamespace(name="end_call"), SimpleNamespace(name="lookup")],
        cancel_tool_reply=lambda: cancelled.append(2),
    )
    suppress_end_call_reply(end_only)
    suppress_end_call_reply(mixed)
    assert cancelled == [1]


class FakeSip:
    def __init__(self, error: Exception | None = None) -> None:
        self.requests: list = []
        self.error = error

    async def transfer_sip_participant(self, request):
        self.requests.append(request)
        if self.error:
            raise self.error


def transfer_setup(phone_identity="phone-+91981", error=None):
    outcome, sip, transfers = CallOutcome(), FakeSip(error), []
    tool = transfer_tool(
        (TransferTarget(name="Sales desk", number="+911712345678", description="New cars"),),
        outcome=outcome,
        room_name=lambda: "call-room",
        phone_identity=lambda: phone_identity,
        livekit_api=lambda: SimpleNamespace(sip=sip),
        on_transfer=lambda target, status, error: transfers.append((target.name, status)),
    )

    async def playout():
        return None

    context = SimpleNamespace(wait_for_playout=playout)
    return tool, context, outcome, sip, transfers


async def test_a_transfer_moves_the_phone_leg_and_ends_the_agents_turn():
    tool, context, outcome, sip, transfers = transfer_setup()
    with pytest.raises(StopResponse):
        await tool({"target": "Sales desk"}, context)
    assert sip.requests[0].transfer_to == "tel:+911712345678"
    assert sip.requests[0].participant_identity == "phone-+91981"
    assert outcome.end_reason == TRANSFERRED and transfers == [("Sales desk", "completed")]


async def test_a_transfer_explains_itself_rather_than_going_silent():
    tool, context, outcome, _, transfers = transfer_setup(error=RuntimeError("REFER rejected"))
    with pytest.raises(ToolError, match="did not go through"):
        await tool({"target": "Sales desk"}, context)
    assert outcome.end_reason is None and transfers == [("Sales desk", "failed")]
    with pytest.raises(ToolError, match="no transfer target"):
        await transfer_setup()[0]({"target": "Accounts"}, context)
    with pytest.raises(ToolError, match="not on a phone line"):
        await transfer_setup(phone_identity=None)[0]({"target": "Sales desk"}, context)


def test_transfer_offers_exactly_the_configured_targets():
    schema = transfer_setup()[0].info.raw_schema
    assert schema["parameters"]["properties"]["target"]["enum"] == ["Sales desk"]
    assert "New cars" in schema["description"]


async def test_keypad_digits_are_delivered_together_once_the_caller_pauses():
    delivered: list[str] = []
    keypad = KeypadInput(delivered.append, settle_seconds=0.02)
    for digit in "12#":
        keypad.press(digit)
    await asyncio.sleep(0.05)
    assert delivered == [keypad_message(["1", "2", "#"])] == ["[keypad: 1 2 #]"]


def test_silence_is_checked_on_then_said_goodbye_to():
    watch = SilenceWatch(max_checks=2)
    assert [watch.caller_away() for _ in range(3)] == [
        SilenceAction.CHECK,
        SilenceAction.CHECK,
        SilenceAction.GOODBYE,
    ]
    watch.caller_spoke()
    assert watch.caller_away() is SilenceAction.CHECK
    assert SilenceWatch(max_checks=0).caller_away() is None
