"""Placing a call from the worker itself, waiting until it is answered.

Waiting is what turns busy, declined, unanswered and unreachable into failures this side
can tell apart, instead of a call that quietly never connects. The dialer decides from
the status whether the number rings again.
"""

from livekit import api

from automitra_worker.control_plane.contract import CallStatus
from automitra_worker.telephony.settings import TelephonySettings

# The number itself is wrong: retrying only reaches the same recording.
UNREACHABLE_SIP_CODES = frozenset({404, 410, 484, 604})
BUSY_SIP_CODES = frozenset({486, 600, 603})  # 603 is a decline: it rang and was rejected.
NO_ANSWER_SIP_CODES = frozenset({408, 480, 487})


def classify_dial_failure(error: BaseException) -> tuple[CallStatus, str]:
    """A failed dial as a call status and a reason worth storing ("sip_486")."""
    sip_code = getattr(error, "sip_status_code", None)
    if sip_code is not None:
        if sip_code in BUSY_SIP_CODES:
            return "busy", f"sip_{sip_code}"
        if sip_code in NO_ANSWER_SIP_CODES:
            return "no_answer", f"sip_{sip_code}"
        return "failed", f"sip_{sip_code}"
    # Ringing out can surface as a deadline rather than a SIP response.
    if getattr(error, "code", None) == api.TwirpErrorCode.DEADLINE_EXCEEDED:
        return "no_answer", "ring_timeout"
    return "failed", "dial_error"


def is_unreachable(end_reason: str | None) -> bool:
    return end_reason in {f"sip_{code}" for code in UNREACHABLE_SIP_CODES}


class OutboundTrunk:
    """The trunk calls are placed through: named outright, or found by name once per
    process and remembered rather than listed on every call."""

    def __init__(self, settings: TelephonySettings) -> None:
        self._settings = settings
        self._trunk_id = settings.outbound_trunk_id

    async def trunk_id(self, livekit_api: api.LiveKitAPI) -> str:
        if self._trunk_id is None:
            existing = await livekit_api.sip.list_sip_outbound_trunk(
                api.ListSIPOutboundTrunkRequest()
            )
            found = next(
                (
                    item
                    for item in existing.items
                    if item.name == self._settings.outbound_trunk_name
                ),
                None,
            )
            if found is None:
                raise RuntimeError(
                    f"no outbound trunk named {self._settings.outbound_trunk_name!r}; run `uv run telephony setup`"
                )
            self._trunk_id = found.sip_trunk_id
        return self._trunk_id


def dial_request(
    settings: TelephonySettings,
    *,
    trunk_id: str,
    room_name: str,
    to_number: str,
    from_number: str | None,
    participant_identity: str,
) -> api.CreateSIPParticipantRequest:
    request = api.CreateSIPParticipantRequest(
        sip_trunk_id=trunk_id,
        sip_call_to=to_number,
        room_name=room_name,
        participant_identity=participant_identity,
        participant_name=to_number,
        krisp_enabled=settings.krisp_enabled,
        wait_until_answered=True,
    )
    if from_number:
        request.sip_number = from_number
    if settings.max_call_seconds is not None:
        request.max_call_duration.FromSeconds(settings.max_call_seconds)
    if settings.ringing_seconds is not None:
        request.ringing_timeout.FromSeconds(settings.ringing_seconds)
    return request


def phone_participant_identity(to_number: str) -> str:
    return f"phone-{to_number}"
