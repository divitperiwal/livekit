import json
from types import SimpleNamespace

import pytest
from livekit import api
from livekit.api.twirp_client import SipCallError

from automitra_worker.control_plane.resolution import JobMetadata
from automitra_worker.telephony.cli import livekit_sip_host, place_call_metadata
from automitra_worker.telephony.outbound import (
    OutboundTrunk,
    classify_dial_failure,
    dial_request,
    is_unreachable,
)
from automitra_worker.telephony.provisioning import dispatch_rule_request, provision
from automitra_worker.telephony.settings import TelephonyConfigError, TelephonySettings

ENABLED = {
    "TELEPHONY_ENABLED": "true",
    "PLIVO_PHONE_NUMBERS": "+911712345678, +911712345679",
    "PLIVO_SIP_USERNAME": "automitra",
    "PLIVO_SIP_PASSWORD": "secret",
    "TELEPHONY_AGENT_NAME": "automitra-worker",
}


def settings(**overrides) -> TelephonySettings:
    return TelephonySettings.from_environment({**ENABLED, **overrides})


def sip_error(code: int) -> SipCallError:
    return SipCallError(
        "unavailable", "call failed", status=503, metadata={"sip_status_code": str(code)}
    )


def test_telephony_is_off_unless_switched_on():
    off = TelephonySettings.from_environment({})
    assert not off.enabled and off.describe() == "telephony=off"
    with pytest.raises(TelephonyConfigError):
        off.require_enabled()


def test_an_enabled_setup_is_read_whole():
    configured = settings(TELEPHONY_MAX_CALL_SECONDS="900", PLIVO_SIP_ZONE="AP")
    assert configured.numbers == ("+911712345678", "+911712345679")
    assert configured.outbound_address == "ap.sip.plivo.com"
    assert configured.krisp_enabled and configured.max_call_seconds == 900
    assert configured.warnings == ()


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"PLIVO_PHONE_NUMBERS": ""}, "PLIVO_PHONE_NUMBERS is empty"),
        ({"PLIVO_PHONE_NUMBERS": "01712345678"}, "E.164"),
        ({"PLIVO_SIP_PASSWORD": ""}, "go together"),
        ({"PLIVO_SIP_USERNAME": "", "PLIVO_SIP_PASSWORD": ""}, "accept SIP from anyone"),
        ({"PLIVO_SIP_ZONE": "mars"}, "not a Plivo zone"),
        ({"TELEPHONY_RINGING_SECONDS": "0"}, "greater than 0"),
        ({"TELEPHONY_MAX_CALL_SECONDS": "ten"}, "whole number"),
    ],
)
def test_an_unsafe_or_incomplete_setup_is_refused(overrides, message):
    with pytest.raises(TelephonyConfigError, match=message):
        settings(**overrides)


def test_an_ip_allowlist_alone_is_enough_and_a_missing_agent_name_is_warned_about():
    allowlisted = settings(
        PLIVO_SIP_USERNAME="",
        PLIVO_SIP_PASSWORD="",
        PLIVO_ALLOWED_ADDRESSES="15.207.90.192/26",
        TELEPHONY_AGENT_NAME="",
    )
    assert allowlisted.allowed_addresses == ("15.207.90.192/26",)
    assert any("TELEPHONY_AGENT_NAME" in warning for warning in allowlisted.warnings)


@pytest.mark.parametrize(
    ("code", "status"),
    [
        (486, "busy"),
        (600, "busy"),
        (603, "busy"),
        (408, "no_answer"),
        (480, "no_answer"),
        (487, "no_answer"),
        (404, "failed"),
        (410, "failed"),
        (484, "failed"),
        (604, "failed"),
        (503, "failed"),
    ],
)
def test_a_failed_dial_is_classified_by_its_sip_code(code, status):
    assert classify_dial_failure(sip_error(code)) == (status, f"sip_{code}")


def test_a_ring_timeout_is_no_answer_and_anything_else_a_failure():
    deadline = api.TwirpError(api.TwirpErrorCode.DEADLINE_EXCEEDED, "timed out", status=504)
    assert classify_dial_failure(deadline) == ("no_answer", "ring_timeout")
    assert classify_dial_failure(RuntimeError("no trunk")) == ("failed", "dial_error")


def test_the_dial_waits_for_an_answer_with_krisp_and_the_limits():
    request = dial_request(
        settings(TELEPHONY_MAX_CALL_SECONDS="900", TELEPHONY_RINGING_SECONDS="30"),
        trunk_id="ST_out",
        room_name="call-1",
        to_number="+919876543210",
        from_number="+911712345678",
        participant_identity="phone-+919876543210",
    )
    assert request.wait_until_answered and request.krisp_enabled
    assert (request.sip_trunk_id, request.sip_number, request.sip_call_to) == (
        "ST_out",
        "+911712345678",
        "+919876543210",
    )
    assert (request.max_call_duration.seconds, request.ringing_timeout.seconds) == (900, 30)


class FakeSipService:
    """Lists, creates and updates SIP objects in memory, like LiveKit's SIP API."""

    def __init__(self) -> None:
        self.inbound: list = []
        self.outbound: list = []
        self.rules: list = []
        self.updates = 0

    async def list_sip_inbound_trunk(self, request):
        return SimpleNamespace(items=list(self.inbound))

    async def list_sip_outbound_trunk(self, request):
        return SimpleNamespace(items=list(self.outbound))

    async def list_sip_dispatch_rule(self, request):
        return SimpleNamespace(items=list(self.rules))

    async def create_sip_inbound_trunk(self, request):
        request.trunk.sip_trunk_id = f"ST_in{len(self.inbound)}"
        self.inbound.append(request.trunk)
        return request.trunk

    async def update_sip_inbound_trunk(self, request):
        self.updates += 1
        self.inbound = [request.replace]
        return request.replace

    async def create_sip_outbound_trunk(self, request):
        request.trunk.sip_trunk_id = f"ST_out{len(self.outbound)}"
        self.outbound.append(request.trunk)
        return request.trunk

    async def update_sip_outbound_trunk(self, request):
        self.updates += 1
        self.outbound = [request.replace]
        return request.replace

    async def create_sip_dispatch_rule(self, request):
        rule = api.SIPDispatchRuleInfo(
            sip_dispatch_rule_id="SDR_1", name=request.name, trunk_ids=list(request.trunk_ids)
        )
        self.rules.append(rule)
        return rule

    async def update_sip_dispatch_rule(self, request):
        self.updates += 1
        self.rules = [request.replace]
        return request.replace


async def test_provisioning_creates_once_and_updates_in_place_on_rerun():
    sip = FakeSipService()
    livekit_api = SimpleNamespace(sip=sip)
    first = await provision(livekit_api, settings())
    second = await provision(livekit_api, settings(TELEPHONY_KRISP="false"))
    assert (len(sip.inbound), len(sip.outbound), len(sip.rules)) == (1, 1, 1)
    assert sip.updates == 3
    assert second.inbound.sip_trunk_id == first.inbound.sip_trunk_id
    assert first.inbound.krisp_enabled and not second.inbound.krisp_enabled
    assert (
        first.inbound.auth_username == "automitra" and first.outbound.address == "ap.sip.plivo.com"
    )


def test_the_dispatch_rule_gives_each_caller_a_room_with_the_named_agent():
    request = dispatch_rule_request(settings(), "ST_in0")
    assert request.rule.dispatch_rule_individual.room_prefix == "call"
    assert request.room_config.agents[0].agent_name == "automitra-worker"


async def test_the_outbound_trunk_is_found_by_name_once_or_taken_as_configured():
    sip = FakeSipService()
    sip.outbound.append(api.SIPOutboundTrunkInfo(sip_trunk_id="ST_out9", name="plivo-outbound"))
    trunk = OutboundTrunk(settings())
    assert await trunk.trunk_id(SimpleNamespace(sip=sip)) == "ST_out9"
    sip.outbound.clear()
    assert await trunk.trunk_id(SimpleNamespace(sip=sip)) == "ST_out9"
    assert (
        await OutboundTrunk(settings(TELEPHONY_OUTBOUND_TRUNK_ID="ST_cfg")).trunk_id(None)
        == "ST_cfg"
    )
    with pytest.raises(RuntimeError, match="telephony setup"):
        await OutboundTrunk(settings()).trunk_id(SimpleNamespace(sip=sip))


def test_the_call_command_dispatches_a_job_the_worker_reads_as_place_this_call():
    metadata = JobMetadata.parse(
        place_call_metadata("+919876543210", "+911712345678", "agent-simran")
    )
    assert metadata.place_call and metadata.direction == "outbound"
    assert (metadata.to_number, metadata.from_number, metadata.agent_id) == (
        "+919876543210",
        "+911712345678",
        "agent-simran",
    )
    assert "agentId" not in json.loads(place_call_metadata("+919876543210", None, None))


def test_the_livekit_sip_host_comes_from_the_project_url():
    assert (
        livekit_sip_host("wss://automitra-ab12cd.livekit.cloud")
        == "automitra-ab12cd.sip.livekit.cloud"
    )
    assert livekit_sip_host("") == "<your LiveKit SIP host>"


def test_only_wrong_numbers_count_as_unreachable():
    assert all(is_unreachable(f"sip_{code}") for code in (404, 410, 484, 604))
    assert not is_unreachable("sip_486") and not is_unreachable(None)
