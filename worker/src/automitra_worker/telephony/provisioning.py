"""Creating the LiveKit side of the Plivo bridge: an inbound trunk, an outbound trunk and a
dispatch rule. Each is matched by name and updated in place, so reruns are safe."""

import logging
from dataclasses import dataclass

from livekit import api

from automitra_worker.telephony.settings import TelephonySettings

logger = logging.getLogger("automitra.provisioning")


@dataclass(frozen=True)
class Provisioned:
    inbound: api.SIPInboundTrunkInfo
    outbound: api.SIPOutboundTrunkInfo
    dispatch: api.SIPDispatchRuleInfo


async def provision(livekit_api: api.LiveKitAPI, settings: TelephonySettings) -> Provisioned:
    settings.require_enabled()
    inbound = await ensure_inbound_trunk(livekit_api, settings)
    logger.info("inbound trunk %s", inbound.sip_trunk_id)
    outbound = await ensure_outbound_trunk(livekit_api, settings)
    logger.info("outbound trunk %s", outbound.sip_trunk_id)
    dispatch = await ensure_dispatch_rule(livekit_api, settings, inbound.sip_trunk_id)
    logger.info("dispatch rule %s", dispatch.sip_dispatch_rule_id)
    return Provisioned(inbound=inbound, outbound=outbound, dispatch=dispatch)


async def ensure_inbound_trunk(
    livekit_api: api.LiveKitAPI, settings: TelephonySettings
) -> api.SIPInboundTrunkInfo:
    trunk = api.SIPInboundTrunkInfo(
        name=settings.inbound_trunk_name,
        numbers=list(settings.numbers),
        allowed_addresses=list(settings.allowed_addresses),
        krisp_enabled=settings.krisp_enabled,
    )
    if settings.auth_username and settings.auth_password:
        trunk.auth_username = settings.auth_username
        trunk.auth_password = settings.auth_password
    if settings.max_call_seconds is not None:
        trunk.max_call_duration.FromSeconds(settings.max_call_seconds)

    existing = await livekit_api.sip.list_sip_inbound_trunk(api.ListSIPInboundTrunkRequest())
    found = next(
        (item for item in existing.items if item.name == settings.inbound_trunk_name), None
    )
    if found is None:
        return await livekit_api.sip.create_sip_inbound_trunk(
            api.CreateSIPInboundTrunkRequest(trunk=trunk)
        )
    trunk.sip_trunk_id = found.sip_trunk_id
    return await livekit_api.sip.update_sip_inbound_trunk(
        api.UpdateSIPInboundTrunkRequest(sip_trunk_id=found.sip_trunk_id, replace=trunk)
    )


async def ensure_outbound_trunk(
    livekit_api: api.LiveKitAPI, settings: TelephonySettings
) -> api.SIPOutboundTrunkInfo:
    trunk = api.SIPOutboundTrunkInfo(
        name=settings.outbound_trunk_name,
        address=settings.outbound_address,
        numbers=list(settings.numbers),
        transport=api.SIPTransport.SIP_TRANSPORT_AUTO,
    )
    if settings.auth_username and settings.auth_password:
        trunk.auth_username = settings.auth_username
        trunk.auth_password = settings.auth_password

    existing = await livekit_api.sip.list_sip_outbound_trunk(api.ListSIPOutboundTrunkRequest())
    found = next(
        (item for item in existing.items if item.name == settings.outbound_trunk_name), None
    )
    if found is None:
        return await livekit_api.sip.create_sip_outbound_trunk(
            api.CreateSIPOutboundTrunkRequest(trunk=trunk)
        )
    trunk.sip_trunk_id = found.sip_trunk_id
    return await livekit_api.sip.update_sip_outbound_trunk(
        api.UpdateSIPOutboundTrunkRequest(sip_trunk_id=found.sip_trunk_id, replace=trunk)
    )


def dispatch_rule_request(
    settings: TelephonySettings, inbound_trunk_id: str
) -> api.CreateSIPDispatchRuleRequest:
    """One room per caller, with the named agent dispatched into it. Noise cancellation
    for inbound calls is a property of the trunk, set above."""
    request = api.CreateSIPDispatchRuleRequest(
        name=settings.dispatch_rule_name,
        trunk_ids=[inbound_trunk_id],
        rule=api.SIPDispatchRule(
            dispatch_rule_individual=api.SIPDispatchRuleIndividual(room_prefix=settings.room_prefix)
        ),
    )
    if settings.agent_name:
        request.room_config.CopyFrom(
            api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=settings.agent_name)])
        )
    return request


async def ensure_dispatch_rule(
    livekit_api: api.LiveKitAPI, settings: TelephonySettings, inbound_trunk_id: str
) -> api.SIPDispatchRuleInfo:
    request = dispatch_rule_request(settings, inbound_trunk_id)
    existing = await livekit_api.sip.list_sip_dispatch_rule(api.ListSIPDispatchRuleRequest())
    found = next(
        (item for item in existing.items if item.name == settings.dispatch_rule_name), None
    )
    if found is None:
        return await livekit_api.sip.create_sip_dispatch_rule(request)
    rule = api.SIPDispatchRuleInfo(
        sip_dispatch_rule_id=found.sip_dispatch_rule_id,
        name=request.name,
        trunk_ids=list(request.trunk_ids),
        rule=request.rule,
        krisp_enabled=settings.krisp_enabled,
    )
    if request.HasField("room_config"):
        rule.room_config.CopyFrom(request.room_config)
    return await livekit_api.sip.update_sip_dispatch_rule(
        api.UpdateSIPDispatchRuleRequest(
            sip_dispatch_rule_id=found.sip_dispatch_rule_id, replace=rule
        )
    )
