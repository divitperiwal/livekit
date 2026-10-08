"""Hanging up once the conversation is over, on a goodbye the caller actually hears."""

import asyncio
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

from livekit.agents import RunContext, function_tool
from livekit.agents.llm import ChatMessage, RawFunctionTool
from livekit.agents.voice import AgentSession, SpeechHandle

from automitra_worker.agent_config.model import ClosingLine
from automitra_worker.pipeline.variables import render
from automitra_worker.reporting.call_outcome import CallOutcome

logger = logging.getLogger("automitra.end_call")

END_CALL_DESCRIPTION = (
    "End the phone call. Call this once the conversation is finished: the caller has said "
    "goodbye, or has what they needed and nothing is left to do. Say a short goodbye in the "
    "same turn; the line closes once it has been spoken.\n\n"
    "Do not call this if the caller asks to hold, to be transferred, or if it is unclear "
    "whether they are finished.\n\n"
    "Set do_not_call to true only if the caller explicitly asked not to be called again."
)
END_CALL_WITH_CLOSING_DESCRIPTION = (
    "End the phone call. Call this once the conversation is finished: the caller has said "
    "goodbye, or has what they needed and nothing is left to do. The closing line is spoken "
    "for you as the call ends, so do not say a goodbye or closing line yourself. Pass the "
    "caller's name if they gave one.\n\n"
    "Do not call this if the caller asks to hold, to be transferred, or if it is unclear "
    "whether they are finished.\n\n"
    "Set do_not_call to true only if the caller explicitly asked not to be called again."
)
GOODBYE_INSTRUCTIONS = (
    "Say a brief goodbye to the caller, in the language of the call, and nothing else."
)
END_CALL_RESULT = "The call is ending."
AGENT_ENDED = "agent_ended"


def closing_line_for(lines: Sequence[ClosingLine], hour: int) -> ClosingLine | None:
    """The first line whose hours contain `hour`: start inclusive, end exclusive, start
    after end runs through midnight, start equal to end covers the whole day."""
    for line in lines:
        if line.start == line.end:
            return line
        if line.start < line.end:
            if line.start <= hour < line.end:
                return line
        elif hour >= line.start or hour < line.end:
            return line
    return None


@dataclass(frozen=True)
class Closing:
    """Chosen when the call ends, not when it starts: a call that runs past six closes on
    the evening line."""

    lines: tuple[ClosingLine, ...]
    timezone: str
    # The call's own values, so an outbound call can close on a name the model never heard.
    variables: Mapping[str, str] = field(default_factory=dict)

    def line(self, caller_name: str, now: datetime | None = None) -> str | None:
        zone = ZoneInfo(self.timezone)
        hour = (now or datetime.now(zone)).astimezone(zone).hour
        chosen = closing_line_for(self.lines, hour)
        if chosen is None:
            return None
        values = dict(self.variables)
        if caller_name.strip():
            values["caller_name"] = caller_name.strip()
        rendered = re.sub(r"\s{2,}", " ", render(chosen.text, values))
        # A missing name leaves "ठीक है  जी ," behind; spoken, the gap is a pause.
        return re.sub(r"\s+([,.!?।])", r"\1", rendered).strip()


def said_something(handle: SpeechHandle) -> bool:
    return any(
        isinstance(item, ChatMessage)
        and item.role == "assistant"
        and (item.text_content or "").strip()
        for item in handle.chat_items
    )


async def close_after_goodbye(
    session: AgentSession, handle: SpeechHandle, closing_line: str | None
) -> None:
    """Ends the session once the turn that called end_call has been heard. Only if the
    model said nothing is it asked for a goodbye, so the common case costs no request."""
    if closing_line:
        await session.say(closing_line, allow_interruptions=False)
    elif not said_something(handle):
        await session.generate_reply(instructions=GOODBYE_INSTRUCTIONS, tool_choice="none")
    session.shutdown()


def suppress_end_call_reply(event: object) -> None:
    """For `function_tools_executed`: no model reply to end_call.

    A reply made the model, which had already said goodbye, call end_call again up to
    the tool-step limit. Cancelling here rather than returning nothing from the tool,
    because an empty tool message makes Sarvam reject every later request in the call.
    """
    calls = list(getattr(event, "function_calls", []) or [])
    if calls and all(call.name == "end_call" for call in calls):
        event.cancel_tool_reply()  # type: ignore[attr-defined]


def end_call_tool(outcome: CallOutcome, closing: Closing | None = None) -> RawFunctionTool:
    async def end_call(raw_arguments: dict[str, object], context: RunContext) -> str:
        if raw_arguments.get("do_not_call") is True:
            outcome.do_not_call = True
            logger.info("the caller asked not to be called again")
        if outcome.end_reason == AGENT_ENDED:
            return END_CALL_RESULT
        outcome.end_reason = AGENT_ENDED
        line = closing.line(str(raw_arguments.get("caller_name") or "")) if closing else None
        # Closed once this turn has played, so the goodbye is heard rather than cut off.
        context.speech_handle.add_done_callback(
            lambda handle: asyncio.ensure_future(close_after_goodbye(context.session, handle, line))
        )
        return END_CALL_RESULT

    properties: dict[str, object] = {
        "do_not_call": {
            "type": "boolean",
            "description": "True only if the caller explicitly asked not to be called again.",
        }
    }
    if closing is not None:
        properties["caller_name"] = {
            "type": "string",
            "description": "The caller's name as they gave it; empty if they did not.",
        }
    return function_tool(
        end_call,
        raw_schema={
            "name": "end_call",
            "description": END_CALL_WITH_CLOSING_DESCRIPTION if closing else END_CALL_DESCRIPTION,
            "parameters": {"type": "object", "properties": properties, "required": []},
        },
    )
