import json
from types import SimpleNamespace

import pytest
from fake_control_plane import RESOLVED_AGENT

from automitra_worker.control_plane.client import CallRefused, ControlPlaneUnavailable, OutOfCredit
from automitra_worker.control_plane.contract import ResolveResponse
from automitra_worker.control_plane.resolution import (
    JobMetadata,
    OutOfCreditRefusal,
    ResolutionFailed,
    resolve_call,
    sip_numbers,
)
from automitra_worker.pipeline.prompt import VOICE_BASE_RULES


class FakeResolver:
    def __init__(self, answer=None, error: Exception | None = None) -> None:
        self.answer = answer or ResolveResponse.model_validate(RESOLVED_AGENT)
        self.error = error
        self.queries: list[dict] = []

    async def resolve(self, **query):
        self.queries.append({key: value for key, value in query.items() if value})
        if self.error:
            raise self.error
        return self.answer


def phone_leg(**attributes):
    async def wait():
        return SimpleNamespace(attributes=attributes)

    return wait


async def no_phone_leg():
    return None


def test_absent_or_malformed_metadata_names_nothing():
    for raw in (None, "", "   ", "not json", "[1, 2]"):
        assert JobMetadata.parse(raw) == JobMetadata()


def test_metadata_is_read_in_either_casing_and_blanks_are_absent():
    camel = JobMetadata.parse(json.dumps({"agentId": "a1", "orgId": "o1", "agentVersionId": " "}))
    snake = JobMetadata.parse(json.dumps({"agent_id": "a1", "org_id": "o1"}))
    assert camel.agent_id == snake.agent_id == "a1"
    assert camel.org_id == snake.org_id == "o1"
    assert camel.agent_version_id is None


def test_dialer_metadata_is_read_and_place_call_must_be_a_real_true():
    metadata = JobMetadata.parse(
        json.dumps(
            {
                "agentId": "a1",
                "placeCall": True,
                "toNumber": "+919876543210",
                "campaignId": "c1",
                "contactId": "k1",
                "requestId": "r1",
                "variables": {"name": "Asha", "due": 1250},
            }
        )
    )
    assert metadata.place_call and metadata.campaign_id == "c1" and metadata.request_id == "r1"
    assert metadata.variables == {"name": "Asha", "due": "1250"}
    assert JobMetadata.parse(json.dumps({"placeCall": "true"})).place_call is False


def test_sip_numbers_reads_the_known_attributes_and_nothing_for_a_browser():
    assert sip_numbers({"sip.phoneNumber": "+91981", "sip.trunkPhoneNumber": "+91171"}) == (
        "+91981",
        "+91171",
    )
    assert sip_numbers({"sip.from": "+91981", "sip.calledNumber": "+91171"}) == ("+91981", "+91171")
    assert sip_numbers({}) == (None, None)


async def test_metadata_resolution_passes_the_org_as_a_claim():
    resolver = FakeResolver()
    metadata = JobMetadata(agent_id="agent-simran", org_id="org-kbs")
    resolved = await resolve_call(metadata, resolver, no_phone_leg)
    assert resolver.queries == [{"agent_id": "agent-simran", "org_id": "org-kbs"}]
    assert resolved.runtime_agent.config.tts_speaker == "priya"
    assert resolved.runtime_agent.name == "simran"
    assert resolved.direction == "inbound"


async def test_a_stored_prompt_mode_reaches_the_prompt():
    answer = ResolveResponse.model_validate(
        {**RESOLVED_AGENT, "promptMode": "verbatim", "config": {"promptMode": "prepend_base_rules"}}
    )
    resolved = await resolve_call(JobMetadata(agent_id="a"), FakeResolver(answer), no_phone_leg)
    assert resolved.runtime_agent.config.prompt_mode == "verbatim"
    assert VOICE_BASE_RULES not in resolved.runtime_agent.instructions


async def test_without_metadata_the_dialled_number_is_looked_up():
    resolver = FakeResolver()
    resolved = await resolve_call(
        JobMetadata(),
        resolver,
        phone_leg(**{"sip.phoneNumber": "+91981", "sip.trunkPhoneNumber": "+91171"}),
    )
    assert resolver.queries == [{"number": "+91171"}]
    assert (resolved.caller_number, resolved.dialled_number) == ("+91981", "+91171")


async def test_a_job_with_nothing_to_resolve_against_fails():
    with pytest.raises(ResolutionFailed, match="no phone participant"):
        await resolve_call(JobMetadata(), FakeResolver(), no_phone_leg)
    with pytest.raises(ResolutionFailed, match="no dialled number"):
        await resolve_call(
            JobMetadata(), FakeResolver(), phone_leg(**{"sip.phoneNumber": "+91981"})
        )


@pytest.mark.parametrize(
    ("error", "raised"),
    [
        (OutOfCredit("no credit"), OutOfCreditRefusal),
        (CallRefused("tenant mismatch"), ResolutionFailed),
        (ControlPlaneUnavailable("timeout"), ResolutionFailed),
    ],
)
async def test_every_refusal_or_failure_becomes_a_resolution_failure(error, raised):
    with pytest.raises(raised):
        await resolve_call(JobMetadata(agent_id="a"), FakeResolver(error=error), no_phone_leg)


async def test_an_invalid_stored_config_fails_resolution_rather_than_running():
    answer = ResolveResponse.model_validate({**RESOLVED_AGENT, "config": {"ttsSpeaker": "anushka"}})
    with pytest.raises(ResolutionFailed, match="invalid config"):
        await resolve_call(JobMetadata(agent_id="a"), FakeResolver(answer), no_phone_leg)


async def test_a_job_with_a_number_to_dial_is_outbound():
    resolved = await resolve_call(
        JobMetadata(agent_id="a", to_number="+919876543210"), FakeResolver(), no_phone_leg
    )
    assert resolved.direction == "outbound"
