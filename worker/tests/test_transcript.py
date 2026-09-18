"""Turning session events into call records.

These run against plain objects rather than a live session, which is the point
of keeping the translation separate from the wiring.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from automitra_worker import transcript


@dataclass
class Item:
    """Stands in for a ChatMessage."""

    role: str = "user"
    text_content: str | None = "hello"
    content: Any = None
    id: str = "item-1"
    interrupted: bool = False
    transcript_confidence: float | None = None


# --- conversation turns -----------------------------------------------------


def test_a_user_turn_becomes_a_user_message() -> None:
    row = transcript.conversation_item(Item(role="user", text_content="namaskar"))
    assert row == {
        "type": "user_message",
        "role": "user",
        "content": "namaskar",
        "payload": {"itemId": "item-1"},
    }


def test_an_assistant_turn_becomes_an_agent_message() -> None:
    row = transcript.conversation_item(Item(role="assistant", text_content="ji boliye"))
    assert row is not None
    assert row["type"] == "agent_message"
    assert row["role"] == "assistant"


def test_system_and_tool_roles_are_not_transcript_turns() -> None:
    for role in ("system", "tool", "developer"):
        assert transcript.conversation_item(Item(role=role)) is None


def test_an_empty_turn_is_not_recorded() -> None:
    """An empty row is noise, not a record of anything."""
    for text in (None, "", "   "):
        assert transcript.conversation_item(Item(text_content=text)) is None


def test_content_falls_back_when_there_is_no_text_content() -> None:
    row = transcript.conversation_item(
        Item(text_content=None, content=["part one", "part two"])
    )
    assert row is not None
    assert row["content"] == "part one part two"


def test_non_text_content_parts_are_dropped() -> None:
    """Audio and image parts have no place in a transcript."""
    row = transcript.conversation_item(
        Item(text_content=None, content=["spoken words", object()])
    )
    assert row is not None
    assert row["content"] == "spoken words"


def test_an_interruption_is_worth_recording() -> None:
    """A call full of interruptions means endpointing is too eager.

    That is invisible from the text alone, so it goes in the payload.
    """
    row = transcript.conversation_item(
        Item(role="assistant", text_content="as I was saying", interrupted=True)
    )
    assert row is not None
    assert row["payload"]["interrupted"] is True


def test_no_interruption_flag_when_not_interrupted() -> None:
    row = transcript.conversation_item(Item())
    assert row is not None
    assert "interrupted" not in row["payload"]


def test_confidence_is_kept_when_reported() -> None:
    row = transcript.conversation_item(Item(transcript_confidence=0.82))
    assert row is not None
    assert row["payload"]["confidence"] == 0.82


def test_a_runaway_turn_is_truncated() -> None:
    """Bounds one row's size; nothing legitimate approaches this."""
    row = transcript.conversation_item(Item(text_content="x" * 40_000))
    assert row is not None
    content = row["content"]
    assert isinstance(content, str)
    assert len(content) < 20_000
    assert content.endswith("[truncated]")


# --- tools ------------------------------------------------------------------


@dataclass
class Call:
    call_id: str = "call-1"
    name: str = "book_test_drive"
    arguments: str = '{"date":"tomorrow"}'


@dataclass
class Output:
    call_id: str = "call-1"
    name: str = "book_test_drive"
    output: str = "booked"
    is_error: bool = False


def test_a_tool_call_and_its_result_are_separate_rows() -> None:
    """A call with no matching result is the interesting case.

    It means the tool never came back, which one merged row would hide.
    """
    rows = transcript.tool_events([Call()], [Output()])
    assert [row["type"] for row in rows] == ["tool_call", "tool_result"]
    assert rows[0]["content"] == "book_test_drive"
    assert rows[1]["content"] == "booked"


def test_a_tool_call_with_no_result_still_records_the_call() -> None:
    rows = transcript.tool_events([Call()], [])
    assert len(rows) == 1
    assert rows[0]["type"] == "tool_call"


def test_a_failed_tool_is_marked() -> None:
    rows = transcript.tool_events([], [Output(is_error=True, output="timed out")])
    assert rows[0]["payload"]["isError"] is True


def test_no_tools_produces_no_rows() -> None:
    assert transcript.tool_events([], []) == []


# --- errors and stages ------------------------------------------------------


def test_an_error_is_recorded_with_its_source() -> None:
    """A transcript that simply stops is hard to account for later."""
    row = transcript.error_event(RuntimeError("stt unavailable"), object())
    assert row["type"] == "error"
    assert "stt unavailable" in str(row["content"])


def test_an_error_message_is_bounded() -> None:
    row = transcript.error_event(RuntimeError("x" * 5000), None)
    assert len(str(row["content"])) <= 1000


def test_a_budget_stage_change_is_recorded() -> None:
    """Explains a call that ends politely but early."""
    row = transcript.stage_event("WRAP", 8.99994321, 10.0)
    assert row["type"] == "stage_change"
    assert row["content"] == "WRAP"
    # Rounded to the paisa-and-then-some: enough to audit a charge, not enough
    # to store floating-point noise.
    assert row["payload"] == {"spentInr": 8.9999, "limitInr": 10.0}


# --- close reasons ----------------------------------------------------------


@dataclass
class Reason:
    value: str = "participant_disconnected"


@dataclass
class CloseEv:
    reason: Any = field(default_factory=Reason)


def test_a_close_reason_is_read_from_the_enum() -> None:
    assert transcript.close_reason(CloseEv()) == "participant_disconnected"


def test_a_plain_string_reason_is_accepted() -> None:
    assert transcript.close_reason(CloseEv(reason="user_initiated")) == "user_initiated"


def test_a_missing_reason_is_not_fatal() -> None:
    assert transcript.close_reason(CloseEv(reason=None)) == "unknown"
