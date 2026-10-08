"""When a machine answers an outbound call: leave a message if configured, then hang up.

Only a voicemail box keeps a message; an IVR menu or a full mailbox is simply hung up on.
"""

import logging

from livekit.agents.voice import AgentSession
from livekit.agents.voice.amd import AMDCategory

from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.reporting.call_outcome import CallOutcome

logger = logging.getLogger("automitra.voicemail")

VOICEMAIL_INSTRUCTIONS = (
    "You have reached voicemail, not a person. Leave a short message: who you are, why you "
    "called, and how they can reach you. Two or three sentences. Do not ask questions; "
    "nobody will answer."
)


def should_leave_message(config: AgentConfigModel, category: AMDCategory) -> bool:
    return config.voicemail_action == "leave_message" and category is AMDCategory.MACHINE_VM


async def handle_machine(
    session: AgentSession, config: AgentConfigModel, outcome: CallOutcome, category: AMDCategory
) -> None:
    outcome.status = "voicemail"
    outcome.end_reason = f"amd_{category.value}"
    if should_leave_message(config, category):
        handle = (
            session.say(config.voicemail_message, allow_interruptions=False)
            if config.voicemail_message
            else session.generate_reply(
                instructions=VOICEMAIL_INSTRUCTIONS, allow_interruptions=False, tool_choice="none"
            )
        )
        try:
            # Awaited, unlike the greeting: something did answer, so it resolves.
            await handle
        except Exception:
            logger.exception("could not leave a voicemail")
    session.shutdown()
