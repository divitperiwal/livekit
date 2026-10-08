"""Telephony settings: Plivo bridged to LiveKit by a pair of SIP trunks.

    caller --PSTN--> Plivo --SIP--> LiveKit SIP --> room --> worker   (inbound)
    worker --> room --> LiveKit SIP --SIP--> Plivo --PSTN--> callee   (outbound)

Read once per process from the environment; a deployment that never touches the phone
network leaves it unset.
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
    # E.164. They scope the inbound trunk to our own numbers and are the outbound caller IDs.
    numbers: tuple[str, ...]
    outbound_address: str
    # One credential pair both ways: Plivo presents it inbound, LiveKit presents it outbound.
    auth_username: str | None
    auth_password: str | None
    # Plivo's signalling IPs. Narrows who may send INVITEs to the inbound trunk.
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
        numbers = listed("PLIVO_PHONE_NUMBERS")
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
            _check_enabled_settings(numbers, username, password, allowed)
            if not agent_name:
                warnings.append(
                    "TELEPHONY_AGENT_NAME is unset, so inbound calls rely on automatic dispatch. "
                    "Set it, and register the worker under the same name."
                )

        return cls(
            enabled=enabled,
            numbers=numbers,
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
            f"telephony=plivo numbers={','.join(self.numbers)} outbound={self.outbound_address} "
            f"agent={self.agent_name or '<automatic dispatch>'} rooms={self.room_prefix}-* krisp={self.krisp_enabled}"
        )


def _check_enabled_settings(
    numbers: tuple[str, ...], username: str | None, password: str | None, allowed: tuple[str, ...]
) -> None:
    if not numbers:
        raise TelephonyConfigError(
            "TELEPHONY_ENABLED is on but PLIVO_PHONE_NUMBERS is empty. List the numbers in "
            "E.164, comma separated: PLIVO_PHONE_NUMBERS=+911234567890"
        )
    not_e164 = [
        number for number in numbers if not number.startswith("+") or not number[1:].isdigit()
    ]
    if not_e164:
        raise TelephonyConfigError(
            f"PLIVO_PHONE_NUMBERS must be E.164, like +911234567890. Not: {', '.join(not_e164)}."
        )
    if bool(username) != bool(password):
        raise TelephonyConfigError(
            "PLIVO_SIP_USERNAME and PLIVO_SIP_PASSWORD go together, or neither."
        )
    # Anyone who finds the URI could place calls billed to us.
    if not username and not allowed:
        raise TelephonyConfigError(
            "The inbound trunk would accept SIP from anyone. Set PLIVO_SIP_USERNAME and "
            "PLIVO_SIP_PASSWORD, or restrict PLIVO_ALLOWED_ADDRESSES to Plivo's signalling IPs."
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
