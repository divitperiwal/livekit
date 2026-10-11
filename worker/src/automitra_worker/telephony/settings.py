"""Telephony settings: Plivo bridged to LiveKit by a pair of SIP trunks.

    caller --PSTN--> Plivo --SIP--> LiveKit SIP --> room --> worker   (inbound)
    worker --> room --> LiveKit SIP --SIP--> Plivo --PSTN--> callee   (outbound)

Read once per process from the environment; a deployment that never touches the phone
network leaves it unset.

Numbers are rented and released while the system runs, so neither trunk lists them: the
inbound trunk takes calls to any number, but only from Plivo's addresses, and the API
refuses a call to a number it does not know. Each outbound call names its own caller ID.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

# Chosen when the Plivo account is created, so configured rather than guessed.
PLIVO_ZONES: dict[str, str] = {
    "ap": "ap.sip.plivo.com",
    "us": "phone.plivo.com",
    "eu": "eu.sip.plivo.com",
}
FALSE_WORDS = {"0", "false", "no", "off"}


class TelephonyConfigError(ValueError):
    """Telephony is on but configured incompletely or unsafely."""


@dataclass(frozen=True)
class TelephonySettings:
    enabled: bool
    outbound_address: str
    # One credential pair both ways: Plivo presents it inbound, LiveKit presents it outbound.
    auth_username: str | None
    auth_password: str | None
    # Plivo's signalling IPs: the only senders the inbound trunk accepts.
    allowed_addresses: tuple[str, ...]
    room_prefix: str
    # Must match the name the worker registers under, or LiveKit dispatches nothing.
    agent_name: str | None
    # Krisp noise cancellation, applied by LiveKit Cloud at the SIP trunk.
    krisp_enabled: bool
    max_call_seconds: int | None
    ringing_seconds: int | None
    outbound_trunk_id: str | None = None
    # Reruns update these by name rather than creating duplicates.
    inbound_trunk_name: str = "plivo-inbound"
    outbound_trunk_name: str = "plivo-outbound"
    dispatch_rule_name: str = "plivo-dispatch"
    warnings: tuple[str, ...] = field(default=())

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] = os.environ) -> "TelephonySettings":
        def value(name: str) -> str | None:
            text = environ.get(name, "").strip()
            return text or None

        def listed(name: str) -> tuple[str, ...]:
            return tuple(item.strip() for item in (value(name) or "").split(",") if item.strip())

        def switch(name: str, default: bool) -> bool:
            text = value(name)
            return default if text is None else text.lower() not in FALSE_WORDS

        enabled = switch("TELEPHONY_ENABLED", False)
        username, password = value("PLIVO_SIP_USERNAME"), value("PLIVO_SIP_PASSWORD")
        allowed = listed("PLIVO_ALLOWED_ADDRESSES")
        agent_name = value("TELEPHONY_AGENT_NAME")

        zone = (value("PLIVO_SIP_ZONE") or "ap").lower()
        if zone in PLIVO_ZONES:
            outbound_address = PLIVO_ZONES[zone]
        elif "." in zone:
            outbound_address = zone
        else:
            raise TelephonyConfigError(
                f"PLIVO_SIP_ZONE={zone!r} is not a Plivo zone. Use one of {', '.join(sorted(PLIVO_ZONES))}, "
                "or a full hostname such as ap.sip.plivo.com."
            )

        warnings: list[str] = []
        if enabled:
            _check_enabled_settings(username, password, allowed)
            if not agent_name:
                warnings.append(
                    "TELEPHONY_AGENT_NAME is unset, so inbound calls rely on automatic dispatch. "
                    "Set it, and register the worker under the same name."
                )

        return cls(
            enabled=enabled,
            outbound_address=outbound_address,
            auth_username=username,
            auth_password=password,
            allowed_addresses=allowed,
            room_prefix=value("TELEPHONY_ROOM_PREFIX") or "call",
            agent_name=agent_name,
            krisp_enabled=switch("TELEPHONY_KRISP", True),
            max_call_seconds=_positive_seconds(
                value("TELEPHONY_MAX_CALL_SECONDS"), "TELEPHONY_MAX_CALL_SECONDS"
            ),
            ringing_seconds=_positive_seconds(
                value("TELEPHONY_RINGING_SECONDS"), "TELEPHONY_RINGING_SECONDS"
            ),
            outbound_trunk_id=value("TELEPHONY_OUTBOUND_TRUNK_ID"),
            warnings=tuple(warnings),
        )

    def require_enabled(self) -> None:
        if not self.enabled:
            raise TelephonyConfigError(
                "Telephony is off. Set TELEPHONY_ENABLED=true and the PLIVO_* settings."
            )

    def describe(self) -> str:
        if not self.enabled:
            return "telephony=off"
        return (
            f"telephony=plivo outbound={self.outbound_address} "
            f"agent={self.agent_name or '<automatic dispatch>'} rooms={self.room_prefix}-* krisp={self.krisp_enabled}"
        )


def _check_enabled_settings(
    username: str | None, password: str | None, allowed: tuple[str, ...]
) -> None:
    if bool(username) != bool(password):
        raise TelephonyConfigError(
            "PLIVO_SIP_USERNAME and PLIVO_SIP_PASSWORD go together, or neither."
        )
    # The inbound trunk takes calls to any number, so only Plivo may send to it: anyone else
    # who found the URI could place calls billed to us.
    if not allowed:
        raise TelephonyConfigError(
            "PLIVO_ALLOWED_ADDRESSES is empty: the inbound trunk, which takes calls to any "
            "number, would accept SIP from anyone. List Plivo's signalling IPs or CIDRs."
        )


def _positive_seconds(text: str | None, name: str) -> int | None:
    if text is None:
        return None
    try:
        seconds = int(text)
    except ValueError as error:
        raise TelephonyConfigError(
            f"{name} must be a whole number of seconds, got {text!r}"
        ) from error
    if seconds <= 0:
        raise TelephonyConfigError(f"{name} must be greater than 0, or unset")
    return seconds
