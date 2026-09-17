"""Telephony: reaching the agent over the phone network via Plivo and SIP.

LiveKit does not speak to Plivo directly. Both speak SIP, so the two are joined
by a pair of trunks:

    caller --PSTN--> Plivo --SIP--> LiveKit SIP --> room --> agent   (inbound)
    agent <-- room <-- LiveKit SIP --SIP--> Plivo --PSTN--> callee   (outbound)

Once a call lands in a room, nothing downstream changes: the same
``AgentSession``, persona and budget logic run whether the audio arrived over
WebRTC or over a phone line.

Three objects have to exist on the LiveKit side, and ``uv run telephony``
creates them:

- an **inbound trunk**, which accepts SIP INVITEs from Plivo for your numbers,
- a **dispatch rule**, which decides the room an inbound call is placed into,
- an **outbound trunk**, which tells LiveKit where to send calls you originate.

Plivo needs matching configuration on its side; ``uv run telephony`` prints it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from livekit import api

from .config import _env, _env_bool, _env_list, _env_opt

logger = logging.getLogger("automitra.telephony")

# Plivo terminates outbound SIP on its zone-specific endpoints. The zone is
# chosen when the Plivo account is created and cannot be inferred, so it is
# configured rather than guessed.
PLIVO_ZONES: dict[str, str] = {
    "ap": "ap.sip.plivo.com",
    "us": "phone.plivo.com",
    "eu": "eu.sip.plivo.com",
}

# Digits the caller may press that the agent should react to. Plivo relays
# these as SIP INFO / RFC 2833, which LiveKit surfaces as room DTMF events.
DEFAULT_KRISP_ENABLED = True


class TelephonyConfigError(ValueError):
    """Telephony is enabled but configured incompletely or inconsistently."""


@dataclass(frozen=True)
class TelephonyConfig:
    """Everything needed to bridge Plivo and LiveKit.

    Read from the environment like the rest of the agent's configuration, so a
    deployment that never touches the phone network simply leaves it unset and
    pays no attention to any of it.
    """

    enabled: bool

    # Numbers in E.164, as Plivo presents them. Used both to scope the inbound
    # trunk (so only your own numbers are accepted) and as the caller ID on
    # outbound calls.
    numbers: tuple[str, ...]

    # Plivo's SIP zone for outbound calls, e.g. "ap.sip.plivo.com".
    outbound_address: str

    # Plivo SIP trunk credentials. The same pair authenticates both directions:
    # Plivo presents them to LiveKit inbound, LiveKit presents them to Plivo
    # outbound.
    auth_username: str | None
    auth_password: str | None

    # Source IPs allowed to send INVITEs to the inbound trunk. Credentials are
    # the primary control; this narrows the blast radius further. Empty means
    # any address, which is only safe with credentials set.
    allowed_addresses: tuple[str, ...]

    # Inbound calls are placed into rooms named with this prefix plus a random
    # suffix, one room per call.
    room_prefix: str

    # Named agent to dispatch into the call's room. Must match the agent name
    # the worker registers under, or LiveKit has nothing to dispatch.
    agent_name: str | None

    # Noise cancellation tuned for phone audio. Phone lines are narrowband and
    # noisy in a way a laptop mic is not, so this matters more here than on
    # WebRTC.
    krisp_enabled: bool

    # A hard cap on how long a single phone call may last, in seconds.
    # Independent of CALL_BUDGET_INR: this bounds wall-clock, not spend.
    max_call_duration: int | None

    # How long to ring an outbound call before giving up, in seconds.
    ringing_timeout: int | None

    # Names given to the LiveKit-side objects, so reruns update rather than
    # duplicate them.
    inbound_trunk_name: str = "plivo-inbound"
    outbound_trunk_name: str = "plivo-outbound"
    dispatch_rule_name: str = "plivo-dispatch"

    # Warnings raised while reading the environment: configuration that is
    # valid but probably not what was intended.
    warnings: tuple[str, ...] = field(default=())

    @classmethod
    def from_env(cls) -> TelephonyConfig:
        enabled = _env_bool("TELEPHONY_ENABLED", False)
        numbers = _env_list("PLIVO_PHONE_NUMBERS")
        zone = _env("PLIVO_SIP_ZONE", "ap").lower()
        auth_username = _env_opt("PLIVO_SIP_USERNAME")
        auth_password = _env_opt("PLIVO_SIP_PASSWORD")
        allowed = _env_list("PLIVO_ALLOWED_ADDRESSES")

        warnings: list[str] = []

        if zone in PLIVO_ZONES:
            outbound_address = PLIVO_ZONES[zone]
        elif "." in zone:
            # A full hostname, for a zone this table does not know about.
            outbound_address = zone
        else:
            raise TelephonyConfigError(
                f"PLIVO_SIP_ZONE={zone!r} is not a known Plivo zone. Use one of "
                f"{', '.join(sorted(PLIVO_ZONES))}, or give a full hostname "
                "such as ap.sip.plivo.com."
            )

        if enabled:
            if not numbers:
                raise TelephonyConfigError(
                    "TELEPHONY_ENABLED is on but PLIVO_PHONE_NUMBERS is empty. "
                    "List the numbers Plivo will send you, in E.164 form, "
                    "comma separated: PLIVO_PHONE_NUMBERS=+911234567890"
                )
            bad = [n for n in numbers if not n.startswith("+") or not n[1:].isdigit()]
            if bad:
                raise TelephonyConfigError(
                    f"PLIVO_PHONE_NUMBERS entries must be E.164, like "
                    f"+911234567890. These are not: {', '.join(bad)}."
                )
            # An inbound trunk with neither credentials nor an address allowlist
            # accepts a call from anyone who finds the URI, and you are billed
            # for it.
            if not (auth_username and auth_password) and not allowed:
                raise TelephonyConfigError(
                    "The inbound trunk would accept SIP from any source. Set "
                    "PLIVO_SIP_USERNAME and PLIVO_SIP_PASSWORD, or restrict "
                    "PLIVO_ALLOWED_ADDRESSES to Plivo's signalling IPs."
                )
            if bool(auth_username) != bool(auth_password):
                raise TelephonyConfigError(
                    "PLIVO_SIP_USERNAME and PLIVO_SIP_PASSWORD must be set "
                    "together, or neither."
                )

        max_call_duration = _env_int_opt("TELEPHONY_MAX_CALL_SECONDS")
        if max_call_duration is not None and max_call_duration <= 0:
            raise TelephonyConfigError(
                "TELEPHONY_MAX_CALL_SECONDS must be greater than 0, or unset "
                "for no limit."
            )

        ringing_timeout = _env_int_opt("TELEPHONY_RINGING_SECONDS")
        if ringing_timeout is not None and ringing_timeout <= 0:
            raise TelephonyConfigError(
                "TELEPHONY_RINGING_SECONDS must be greater than 0, or unset "
                "for the LiveKit default."
            )

        agent_name = _env_opt("TELEPHONY_AGENT_NAME")
        if enabled and not agent_name:
            # Without a named agent, dispatch falls back to any worker
            # listening for automatic jobs. That works for a single-purpose
            # deployment and breaks confusingly the moment there are two.
            warnings.append(
                "TELEPHONY_AGENT_NAME is unset, so inbound calls rely on "
                "automatic dispatch. Set it (and register the worker under the "
                "same name) once more than one agent shares the project."
            )

        return cls(
            enabled=enabled,
            numbers=numbers,
            outbound_address=outbound_address,
            auth_username=auth_username,
            auth_password=auth_password,
            allowed_addresses=allowed,
            room_prefix=_env("TELEPHONY_ROOM_PREFIX", "call"),
            agent_name=agent_name,
            krisp_enabled=_env_bool("TELEPHONY_KRISP", DEFAULT_KRISP_ENABLED),
            max_call_duration=max_call_duration,
            ringing_timeout=ringing_timeout,
            warnings=tuple(warnings),
        )

    def require_enabled(self) -> None:
        if not self.enabled:
            raise TelephonyConfigError(
                "Telephony is off. Set TELEPHONY_ENABLED=true in .env.local "
                "and fill in the PLIVO_* settings."
            )

    def describe(self) -> str:
        if not self.enabled:
            return "telephony=off"
        agent = self.agent_name or "<automatic dispatch>"
        return (
            f"telephony=plivo numbers={','.join(self.numbers)} "
            f"outbound={self.outbound_address} agent={agent} "
            f"rooms={self.room_prefix}-* krisp={self.krisp_enabled}"
        )


def _env_int_opt(name: str) -> int | None:
    raw = _env_opt(name)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError as exc:
        raise TelephonyConfigError(
            f"{name} must be a whole number of seconds, got {raw!r}"
        ) from exc


# --- Provisioning -----------------------------------------------------------
#
# Each helper is idempotent on the object's name: an existing object with the
# same name is updated in place rather than duplicated, so the setup command
# can be rerun after any config change.


async def _find_inbound(lk: api.LiveKitAPI, name: str) -> api.SIPInboundTrunkInfo | None:
    existing = await lk.sip.list_sip_inbound_trunk(api.ListSIPInboundTrunkRequest())
    return next((t for t in existing.items if t.name == name), None)


async def _find_outbound(
    lk: api.LiveKitAPI, name: str
) -> api.SIPOutboundTrunkInfo | None:
    existing = await lk.sip.list_sip_outbound_trunk(api.ListSIPOutboundTrunkRequest())
    return next((t for t in existing.items if t.name == name), None)


async def _find_rule(lk: api.LiveKitAPI, name: str) -> api.SIPDispatchRuleInfo | None:
    existing = await lk.sip.list_sip_dispatch_rule(api.ListSIPDispatchRuleRequest())
    return next((r for r in existing.items if r.name == name), None)


async def ensure_inbound_trunk(
    lk: api.LiveKitAPI, config: TelephonyConfig
) -> api.SIPInboundTrunkInfo:
    """Create or update the trunk that accepts calls from Plivo."""
    trunk = api.SIPInboundTrunkInfo(
        name=config.inbound_trunk_name,
        numbers=list(config.numbers),
        allowed_addresses=list(config.allowed_addresses),
        krisp_enabled=config.krisp_enabled,
    )
    if config.auth_username and config.auth_password:
        trunk.auth_username = config.auth_username
        trunk.auth_password = config.auth_password
    if config.max_call_duration is not None:
        trunk.max_call_duration.FromSeconds(config.max_call_duration)

    found = await _find_inbound(lk, config.inbound_trunk_name)
    if found is None:
        return await lk.sip.create_sip_inbound_trunk(
            api.CreateSIPInboundTrunkRequest(trunk=trunk)
        )

    trunk.sip_trunk_id = found.sip_trunk_id
    return await lk.sip.update_sip_inbound_trunk(
        api.UpdateSIPInboundTrunkRequest(
            sip_trunk_id=found.sip_trunk_id, replace=trunk
        )
    )


async def ensure_outbound_trunk(
    lk: api.LiveKitAPI, config: TelephonyConfig
) -> api.SIPOutboundTrunkInfo:
    """Create or update the trunk used to place calls through Plivo."""
    trunk = api.SIPOutboundTrunkInfo(
        name=config.outbound_trunk_name,
        address=config.outbound_address,
        numbers=list(config.numbers),
        transport=api.SIPTransport.SIP_TRANSPORT_AUTO,
    )
    if config.auth_username and config.auth_password:
        trunk.auth_username = config.auth_username
        trunk.auth_password = config.auth_password

    found = await _find_outbound(lk, config.outbound_trunk_name)
    if found is None:
        return await lk.sip.create_sip_outbound_trunk(
            api.CreateSIPOutboundTrunkRequest(trunk=trunk)
        )

    trunk.sip_trunk_id = found.sip_trunk_id
    return await lk.sip.update_sip_outbound_trunk(
        api.UpdateSIPOutboundTrunkRequest(
            sip_trunk_id=found.sip_trunk_id, replace=trunk
        )
    )


def _dispatch_request(
    config: TelephonyConfig, trunk_id: str
) -> api.CreateSIPDispatchRuleRequest:
    """One room per inbound call, with the agent dispatched into it.

    ``dispatch_rule_individual`` gives each caller their own room, which is
    what a one-to-one phone conversation wants; the alternative puts every
    caller into a single shared room.

    Noise cancellation is not set here -- for inbound calls it is a property of
    the trunk the call arrives on, which ``ensure_inbound_trunk`` already sets.
    """
    request = api.CreateSIPDispatchRuleRequest(
        name=config.dispatch_rule_name,
        trunk_ids=[trunk_id],
        rule=api.SIPDispatchRule(
            dispatch_rule_individual=api.SIPDispatchRuleIndividual(
                room_prefix=config.room_prefix,
            )
        ),
    )
    if config.agent_name:
        request.room_config.CopyFrom(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=config.agent_name)]
            )
        )
    return request


async def ensure_dispatch_rule(
    lk: api.LiveKitAPI, config: TelephonyConfig, trunk_id: str
) -> api.SIPDispatchRuleInfo:
    """Create or update the rule routing inbound calls into agent rooms."""
    request = _dispatch_request(config, trunk_id)

    found = await _find_rule(lk, config.dispatch_rule_name)
    if found is None:
        return await lk.sip.create_sip_dispatch_rule(request)

    rule = api.SIPDispatchRuleInfo(
        sip_dispatch_rule_id=found.sip_dispatch_rule_id,
        name=request.name,
        trunk_ids=list(request.trunk_ids),
        rule=request.rule,
        krisp_enabled=config.krisp_enabled,
    )
    if request.HasField("room_config"):
        rule.room_config.CopyFrom(request.room_config)
    return await lk.sip.update_sip_dispatch_rule(
        api.UpdateSIPDispatchRuleRequest(
            sip_dispatch_rule_id=found.sip_dispatch_rule_id, replace=rule
        )
    )


@dataclass(frozen=True)
class Provisioned:
    """What ``provision`` created or updated, for reporting."""

    inbound: api.SIPInboundTrunkInfo
    outbound: api.SIPOutboundTrunkInfo
    dispatch: api.SIPDispatchRuleInfo


async def provision(config: TelephonyConfig) -> Provisioned:
    """Bring LiveKit's SIP objects in line with the configuration."""
    config.require_enabled()
    async with api.LiveKitAPI() as lk:
        inbound = await ensure_inbound_trunk(lk, config)
        logger.info("inbound trunk %s", inbound.sip_trunk_id)
        outbound = await ensure_outbound_trunk(lk, config)
        logger.info("outbound trunk %s", outbound.sip_trunk_id)
        dispatch = await ensure_dispatch_rule(lk, config, inbound.sip_trunk_id)
        logger.info("dispatch rule %s", dispatch.sip_dispatch_rule_id)
        return Provisioned(inbound=inbound, outbound=outbound, dispatch=dispatch)


# --- Outbound calls ---------------------------------------------------------


async def place_call(
    config: TelephonyConfig,
    to_number: str,
    *,
    room_name: str,
    from_number: str | None = None,
    wait_until_answered: bool = True,
) -> api.SIPParticipantInfo:
    """Dial ``to_number`` and put the answered call into ``room_name``.

    The agent is dispatched into that room separately, by name, so the worker
    must be running and registered under ``TELEPHONY_AGENT_NAME`` before the
    callee picks up -- otherwise they are answered by silence.

    With ``wait_until_answered`` the call returns only once the callee actually
    picks up, so a busy signal or a decline surfaces here as an error rather
    than as a call that quietly never connects.
    """
    config.require_enabled()
    if not to_number.startswith("+"):
        raise TelephonyConfigError(
            f"The number to call must be E.164, like +911234567890. Got {to_number!r}."
        )

    caller_id = from_number or config.numbers[0]
    if caller_id not in config.numbers:
        raise TelephonyConfigError(
            f"Caller ID {caller_id} is not one of your Plivo numbers "
            f"({', '.join(config.numbers)}). Plivo will reject the call."
        )

    async with api.LiveKitAPI() as lk:
        outbound = await _find_outbound(lk, config.outbound_trunk_name)
        if outbound is None:
            raise TelephonyConfigError(
                "No outbound trunk exists yet. Run `uv run telephony` first."
            )

        request = api.CreateSIPParticipantRequest(
            sip_trunk_id=outbound.sip_trunk_id,
            sip_call_to=to_number,
            sip_number=caller_id,
            room_name=room_name,
            # The identity marks this participant as the far end of a phone
            # call, which is how the agent tells a caller from another agent.
            participant_identity=f"phone-{to_number}",
            participant_name=to_number,
            krisp_enabled=config.krisp_enabled,
            wait_until_answered=wait_until_answered,
        )
        if config.max_call_duration is not None:
            request.max_call_duration.FromSeconds(config.max_call_duration)
        if config.ringing_timeout is not None:
            request.ringing_timeout.FromSeconds(config.ringing_timeout)

        return await lk.sip.create_sip_participant(request)


async def dispatch_agent(agent_name: str, room_name: str, *, metadata: str = "") -> None:
    """Ask LiveKit to put the named agent into a room.

    Outbound calls need this explicitly: nobody has dialled in, so no dispatch
    rule has fired and the room would otherwise have no agent in it.
    """
    async with api.LiveKitAPI() as lk:
        await lk.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=agent_name, room=room_name, metadata=metadata
            )
        )


async def hangup(room_name: str) -> None:
    """End a call by deleting its room, dropping every participant."""
    async with api.LiveKitAPI() as lk:
        await lk.room.delete_room(api.DeleteRoomRequest(room=room_name))
