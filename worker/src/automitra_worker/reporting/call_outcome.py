"""How a call went, written by whichever part of it finds out and read once at finalize."""

from dataclasses import dataclass

from automitra_worker.control_plane.contract import CallStatus


@dataclass
class CallOutcome:
    status: CallStatus = "completed"
    # Set when the call itself decides why it ended (a transfer, voicemail, the agent
    # hanging up); otherwise the budget stage or the session's close reason is used.
    end_reason: str | None = None
    answered: bool = True
    do_not_call: bool = False
