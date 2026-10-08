"""Handing the phone call to a person: a cold transfer by SIP REFER.

The carrier connects the caller onward and the agent leaves. The carrier trunk has to
allow transfers; a refused one comes back as an error the agent explains, not silence.
"""

import logging
from collections.abc import Callable

from livekit import api
from livekit.agents import RunContext, function_tool
from livekit.agents.llm import RawFunctionTool, StopResponse, ToolError

from automitra_worker.agent_config.model import TransferTarget
from automitra_worker.reporting.call_outcome import CallOutcome

logger = logging.getLogger("automitra.transfer")

TRANSFERRED = "transferred"


def transfer_description(targets: tuple[TransferTarget, ...]) -> str:
    lines = [
        "Transfer the caller to a person. Before calling this, tell the caller you are "
        "transferring them and wait for them to hear it. Only transfer when the caller asks "
        "for a person or needs something you cannot do. Where you can transfer to:"
    ]
    lines += [
        f"- {target.name}: {target.description}" if target.description else f"- {target.name}"
        for target in targets
    ]
    return "\n".join(lines)


def transfer_tool(
    targets: tuple[TransferTarget, ...],
    *,
    outcome: CallOutcome,
    room_name: Callable[[], str],
    phone_identity: Callable[[], str | None],
    livekit_api: Callable[[], api.LiveKitAPI],
    on_transfer: Callable[[TransferTarget, str, str | None], None],
) -> RawFunctionTool:
    by_name = {target.name: target for target in targets}

    async def transfer_call(raw_arguments: dict[str, object], context: RunContext) -> None:
        target = by_name.get(str(raw_arguments.get("target") or ""))
        if target is None:
            raise ToolError(
                f"There is no transfer target by that name. Choose one of: {', '.join(by_name)}."
            )
        identity = phone_identity()
        if identity is None:
            raise ToolError(
                "This caller is not on a phone line, so they cannot be transferred. "
                "Tell them, and offer to help another way."
            )
        # Let "I'm transferring you now" finish before the line moves.
        await context.wait_for_playout()
        try:
            await livekit_api().sip.transfer_sip_participant(
                api.TransferSIPParticipantRequest(
                    room_name=room_name(),
                    participant_identity=identity,
                    transfer_to=f"tel:{target.number}",
                    play_dialtone=False,
                )
            )
        except Exception as error:
            logger.warning("transfer to %s failed: %s", target.name, error)
            on_transfer(target, "failed", str(error)[:300])
            raise ToolError(
                "The transfer did not go through. Apologise, and offer to help another way "
                "or to have someone call back."
            ) from error
        outcome.end_reason = TRANSFERRED
        on_transfer(target, "completed", None)
        logger.info("transferred the caller to %s", target.name)
        # The caller has left; there is nobody to reply to.
        raise StopResponse()

    return function_tool(
        transfer_call,
        raw_schema={
            "name": "transfer_call",
            "description": transfer_description(targets),
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
