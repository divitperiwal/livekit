"""The built-in tools for controlling a call, and placing one.

Customer tools talk to the outside world. These talk to the phone line itself:
ending the call when the conversation is over, handing it to a person, and --
for a call the worker places -- dialling, and noticing when the far end is an
answering machine rather than a person.

All of them report into one :class:`CallOutcome`, which is what the call
record is finalised from. The alternative -- each path writing its own status
-- is how a voicemail ends up recorded as a completed conversation, or an
unanswered call gets billed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

from livekit import api
from livekit.agents import RunContext, function_tool
from livekit.agents.llm import ChatMessage, RawFunctionTool, StopResponse, ToolError
from livekit.agents.voice import AgentSession, SpeechHandle

from .agent_config_model import ClosingLine, TransferTarget
from .variables import render

logger = logging.getLogger("automitra.call_control")


@dataclass
class CallOutcome:
    """How a call went, filled in as it happens and read once at the end."""

    # completed | no_answer | busy | failed | voicemail
    status: str = "completed"
    # Whether anyone -- or anything -- picked up. An unanswered call carries no
    # usage and is not charged for.
    answered: bool = True
    # Why the call ended, when something here decided it. Overrides the SDK's
    # close reason, which would only say "the session closed".
    end_reason: str | None = None
    # The caller asked not to be called again.
    do_not_call: bool = False


# --- ending the call ----------------------------------------------------------

END_CALL_DESCRIPTION = (
    "End the phone call. Call this once the conversation is finished: the "
    "caller has said goodbye, or has what they needed and nothing is left to "
    "do. Say a short goodbye in the same turn; the line closes once it has "
    "been spoken.\n\n"
    "Do not call this if the caller asks to hold, to be transferred, or if it "
    "is unclear whether they are finished.\n\n"
    "Set do_not_call to true only if the caller explicitly asked not to be "
    "called again."
)


END_CALL_WITH_CLOSING_DESCRIPTION = (
    "End the phone call. Call this once the conversation is finished: the "
    "caller has said goodbye, or has what they needed and nothing is left to "
    "do. The closing line is spoken for you as the call ends, so do not say a "
    "goodbye or closing line yourself. Pass the caller's name if they gave "
    "one.\n\n"
    "Do not call this if the caller asks to hold, to be transferred, or if it "
    "is unclear whether they are finished.\n\n"
    "Set do_not_call to true only if the caller explicitly asked not to be "
    "called again."
)


GOODBYE_INSTRUCTIONS = (
    "Say a brief goodbye to the caller, in the language of the call, and nothing else."
)


@dataclass(frozen=True)
class Closing:
    """An agent's closing lines, and what they are filled in with.

    Chosen when the call ends rather than when it starts: a call that runs
    past six o'clock should close on the evening line.
    """

    lines: tuple[ClosingLine, ...]
    timezone: str
    # The call's own values, so an outbound call can close on a contact's
    # name the model never heard.
    variables: Mapping[str, str] = field(default_factory=dict)

    def line(self, caller_name: str, now: datetime | None = None) -> str | None:
        hour = (now or datetime.now(ZoneInfo(self.timezone))).astimezone(ZoneInfo(self.timezone)).hour
        chosen = closing_line_for(self.lines, hour)
        if chosen is None:
            return None
        values = dict(self.variables)
        if caller_name.strip():
            values["caller_name"] = caller_name.strip()
        rendered = render(chosen.text, values)
        # A missing name leaves "ठीक है  जी," behind; spoken, the gap is a
        # pause, so it is closed up.
        rendered = re.sub(r"\s{2,}", " ", rendered)
        return re.sub(r"\s+([,.!?।])", r"\1", rendered).strip()


def closing_line_for(lines: Sequence[ClosingLine], hour: int) -> ClosingLine | None:
    """The first line whose hours contain ``hour``; see :class:`ClosingLine`."""
    for line in lines:
        if line.start == line.end:
            return line
        if line.start < line.end:
            if line.start <= hour < line.end:
                return line
        elif hour >= line.start or hour < line.end:
            return line
    return None


def said_something(handle: SpeechHandle) -> bool:
    """Whether the agent spoke any words in this turn."""
    return any(
        isinstance(item, ChatMessage) and item.role == "assistant" and (item.text_content or "").strip()
        for item in handle.chat_items
    )


async def close_after_goodbye(
    session: AgentSession, handle: SpeechHandle, closing_line: str | None = None
) -> None:
    """Ends the session once the turn that called end_call has been heard.

    With a closing line, that is what the caller hears last, spoken as
    written. Otherwise the goodbye normally comes in that same turn, before
    the tool call. Only if the model called end_call without a word is it
    asked for one, so the caller is never hung up on in silence -- and the
    common case costs no extra model request.
    """
    if closing_line:
        await session.say(closing_line, allow_interruptions=False)
    elif not said_something(handle):
        await session.generate_reply(instructions=GOODBYE_INSTRUCTIONS, tool_choice="none")
    session.shutdown()


END_CALL_RESULT = "The call is ending."


def suppress_end_call_reply(ev: object) -> None:
    """Asks for no model reply to end_call; for ``function_tools_executed``.

    A reply was what made the model -- which had already said goodbye -- call
    end_call again, up to the tool-step limit: three wasted model requests of
    the whole prompt each, and the line held open seconds after the goodbye.

    The reply is cancelled here rather than by the tool returning nothing,
    because nothing is recorded as a tool message with empty content, and
    Sarvam rejects every later request in the call that carries one --
    including the goodbye close_after_goodbye may still need.
    """
    calls = list(getattr(ev, "function_calls", []) or [])
    if calls and all(call.name == "end_call" for call in calls):
        ev.cancel_tool_reply()  # type: ignore[attr-defined]


def end_call_tool(outcome: CallOutcome, closing: Closing | None = None) -> RawFunctionTool:
    async def end_call(raw_arguments: dict[str, object], context: RunContext) -> str:
        if raw_arguments.get("do_not_call") is True:
            outcome.do_not_call = True
            logger.info("the caller asked not to be called again")
        if outcome.end_reason == "agent_ended":
            # Already closing; a second call in the same turn changes nothing.
            return END_CALL_RESULT
        outcome.end_reason = "agent_ended"

        line = None
        if closing is not None:
            line = closing.line(str(raw_arguments.get("caller_name") or ""))

        # Closed once this turn has finished playing, so the goodbye is heard
        # rather than cut off. By then its text is on the handle, which is how
        # close_after_goodbye knows whether one was said.
        handle = context.speech_handle
        handle.add_done_callback(
            lambda h: asyncio.ensure_future(close_after_goodbye(context.session, h, line))
        )
        return END_CALL_RESULT

    properties: dict[str, object] = {
        "do_not_call": {
            "type": "boolean",
            "description": (
                "True only if the caller explicitly asked not to be "
                "called again."
            ),
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
            "description": (
                END_CALL_WITH_CLOSING_DESCRIPTION if closing is not None else END_CALL_DESCRIPTION
            ),
            "parameters": {"type": "object", "properties": properties, "required": []},
        },
    )


# --- transferring the call ----------------------------------------------------


def _transfer_description(targets: tuple[TransferTarget, ...]) -> str:
    lines = [
        "Transfer the caller to a person. Before calling this, tell the caller "
        "you are transferring them and wait for them to hear it. Only transfer "
        "when the caller asks for a person or needs something you cannot do. "
        "Where you can transfer to:"
    ]
    for target in targets:
        lines.append(
            f"- {target.name}: {target.description}" if target.description else f"- {target.name}"
        )
    return "\n".join(lines)


def transfer_tool(
    targets: tuple[TransferTarget, ...],
    *,
    outcome: CallOutcome,
    room_name: Callable[[], str],
    phone_identity: Callable[[], str | None],
    lk: Callable[[], api.LiveKitAPI],
    on_transfer: Callable[[TransferTarget, str, str | None], None],
) -> RawFunctionTool:
    """A tool that hands the phone call to one of ``targets``.

    A cold transfer, by SIP REFER: the carrier connects the caller onward and
    the agent leaves the call. The carrier trunk has to allow transfers for
    this to work, and a refused transfer comes back as an error the agent
    explains to the caller rather than as silence.
    """
    by_name = {target.name: target for target in targets}

    async def transfer_call(raw_arguments: dict[str, object], context: RunContext) -> None:
        target = by_name.get(str(raw_arguments.get("target") or ""))
        if target is None:
            raise ToolError(
                f"There is no transfer target by that name. Choose one of: "
                f"{', '.join(by_name)}."
            )

        identity = phone_identity()
        if identity is None:
            # A browser test call has no phone line to hand over.
            raise ToolError(
                "This caller is not on a phone line, so they cannot be "
                "transferred. Tell them, and offer to help another way."
            )

        # Let "I'm transferring you now" finish before the line moves.
        await context.wait_for_playout()

        try:
            await lk().sip.transfer_sip_participant(
                api.TransferSIPParticipantRequest(
                    room_name=room_name(),
                    participant_identity=identity,
                    transfer_to=f"tel:{target.number}",
                    play_dialtone=False,
                )
            )
        except Exception as exc:
            logger.warning("transfer to %s failed: %s", target.name, exc)
            on_transfer(target, "failed", str(exc)[:300])
            raise ToolError(
                "The transfer did not go through. Apologise, and offer to help "
                "another way or to have someone call back."
            ) from exc

        outcome.end_reason = "transferred"
        on_transfer(target, "completed", None)
        logger.info("transferred the caller to %s", target.name)
        # The caller has left; there is nobody to reply to.
        raise StopResponse()

    return function_tool(
        transfer_call,
        raw_schema={
            "name": "transfer_call",
            "description": _transfer_description(targets),
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "enum": list(by_name),
                        "description": "Where to transfer the caller.",
                    }
                },
                "required": ["target"],
            },
        },
    )


# --- placing a call -----------------------------------------------------------

# SIP responses that mean the number itself is wrong. Retrying these only
# spends money reaching the same recording.
UNREACHABLE_CODES = frozenset({404, 410, 484, 604})


def classify_dial_failure(exc: BaseException) -> tuple[str, str]:
    """Map a failed dial to a call status and a reason worth storing.

    The status decides what the dialer does next: ``busy`` and ``no_answer``
    are worth another attempt later, and ``failed`` with an ``sip_4xx`` reason
    in :data:`UNREACHABLE_CODES` is not worth any.
    """
    code = getattr(exc, "sip_status_code", None)
    if code is not None:
        if code in (486, 600, 603):
            # 603 is a decline: the phone rang and was rejected, which is a
            # person being busy rather than a number that does not work.
            return "busy", f"sip_{code}"
        if code in (408, 480, 487):
            return "no_answer", f"sip_{code}"
        return "failed", f"sip_{code}"

    # Ringing out without an answer can surface as a deadline rather than a
    # SIP response, depending on which side gave up first.
    if getattr(exc, "code", None) == api.TwirpErrorCode.DEADLINE_EXCEEDED:
        return "no_answer", "ring_timeout"
    return "failed", "dial_error"


_outbound_trunk_id: str | None = None


async def outbound_trunk_id(lk: api.LiveKitAPI, trunk_name: str) -> str:
    """The LiveKit trunk calls are placed through.

    ``TELEPHONY_OUTBOUND_TRUNK_ID`` names it outright; otherwise it is found by
    name once per process and remembered, rather than listed on every call.
    """
    global _outbound_trunk_id
    configured = os.getenv("TELEPHONY_OUTBOUND_TRUNK_ID", "").strip()
    if configured:
        return configured
    if _outbound_trunk_id is None:
        existing = await lk.sip.list_sip_outbound_trunk(api.ListSIPOutboundTrunkRequest())
        found = next((t for t in existing.items if t.name == trunk_name), None)
        if found is None:
            raise RuntimeError(
                f"no outbound trunk named {trunk_name!r}; run `uv run telephony` first"
            )
        _outbound_trunk_id = found.sip_trunk_id
    return _outbound_trunk_id


# --- answering machines -------------------------------------------------------

VOICEMAIL_INSTRUCTIONS = (
    "You have reached voicemail, not a person. Leave a short message: who you "
    "are, why you called, and how they can reach you. Two or three sentences. "
    "Do not ask questions; nobody will answer."
)
