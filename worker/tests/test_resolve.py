"""Working out which tenant a job belongs to.

The rule this file protects: a call is answered as the agent it is actually
for, or it is not answered at all. Every path that could quietly substitute a
different tenant's configuration is a bug, so the tests below are mostly about
refusing rather than succeeding.
"""

from __future__ import annotations

import pytest

from automitra_worker.control_plane import AgentNotResolved, ResolvedAgent
from automitra_worker.resolve import (
    JobMeta,
    ResolutionFailed,
    _resolve_by_number,
    _resolve_from_meta,
    sip_numbers,
)


# --- reading job metadata ---------------------------------------------------


def test_absent_metadata_identifies_nothing() -> None:
    for raw in (None, "", "   "):
        meta = JobMeta.parse(raw)
        assert not meta.identifies_an_agent
        assert meta.org_id is None


def test_metadata_is_read_in_either_casing() -> None:
    """The control plane writes JSON camelCased; Python speaks snake_case."""
    camel = JobMeta.parse('{"orgId":"o1","agentVersionId":"v1","direction":"outbound"}')
    snake = JobMeta.parse(
        '{"org_id":"o1","agent_version_id":"v1","direction":"outbound"}'
    )
    assert camel == snake
    assert camel.org_id == "o1"
    assert camel.agent_version_id == "v1"


def test_malformed_metadata_is_ignored_rather_than_fatal() -> None:
    """The dialled number may still resolve the call.

    Raising here would turn a recoverable situation -- metadata we cannot read,
    on a call whose number we could have looked up -- into a dropped call.
    """
    for raw in ("not json", "[1,2,3]", '"a string"', "null"):
        assert not JobMeta.parse(raw).identifies_an_agent


def test_blank_values_are_treated_as_absent() -> None:
    meta = JobMeta.parse('{"agentId":"   ","orgId":""}')
    assert not meta.identifies_an_agent
    assert meta.org_id is None


def test_a_version_or_an_agent_both_identify_one() -> None:
    assert JobMeta.parse('{"agentVersionId":"v1"}').identifies_an_agent
    assert JobMeta.parse('{"agentId":"a1"}').identifies_an_agent


def test_variables_survive_for_the_prompt() -> None:
    meta = JobMeta.parse('{"agentId":"a1","variables":{"name":"Asha"}}')
    assert meta.variables == {"name": "Asha"}


def test_non_object_variables_are_dropped() -> None:
    assert JobMeta.parse('{"agentId":"a1","variables":"nope"}').variables is None


# --- reading numbers off the phone leg --------------------------------------


class FakeParticipant:
    def __init__(self, attributes: dict[str, str]) -> None:
        self.attributes = attributes


def test_sip_numbers_reads_the_documented_attributes() -> None:
    caller, dialled = sip_numbers(
        FakeParticipant(
            {"sip.phoneNumber": "+919000000001", "sip.trunkPhoneNumber": "+911111111111"}
        )
    )
    assert caller == "+919000000001"
    assert dialled == "+911111111111"


def test_sip_numbers_accepts_alternative_attribute_names() -> None:
    """These are set by the SIP service, not by this SDK.

    The names cannot be verified from the installed packages, so several
    candidates are tried rather than one assumed.
    """
    caller, dialled = sip_numbers(
        FakeParticipant({"sip.from": "+919000000002", "sip.to": "+912222222222"})
    )
    assert caller == "+919000000002"
    assert dialled == "+912222222222"


def test_sip_numbers_is_empty_for_a_browser_participant() -> None:
    assert sip_numbers(FakeParticipant({})) == (None, None)


# --- resolution failures ----------------------------------------------------


AGENT = ResolvedAgent(
    org_id="org-1",
    agent_id="agent-1",
    agent_version_id="version-1",
    agent_slug="simran",
    prompt_mode="verbatim",
    instructions="You are Simran.",
    greeting="namaskar",
    config={},
    record_calls=False,
)


class FakeControlPlane:
    """Stands in for the API, recording what it was asked."""

    def __init__(self, result: object = AGENT) -> None:
        self.result = result
        self.calls: list[dict] = []

    async def resolve(self, **kwargs: object) -> ResolvedAgent:
        self.calls.append(kwargs)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result  # type: ignore[return-value]


async def test_metadata_resolution_passes_the_org_as_a_claim() -> None:
    """The org is stated so the control plane can refuse a mismatch.

    Not passing it would let a job whose metadata named another tenant's agent
    reach that agent, which is the isolation failure that matters most here.
    """
    plane = FakeControlPlane()
    meta = JobMeta.parse('{"orgId":"org-1","agentId":"agent-1"}')
    await _resolve_from_meta(meta, plane)  # type: ignore[arg-type]
    assert plane.calls[0]["org_id"] == "org-1"
    assert plane.calls[0]["agent_id"] == "agent-1"


async def test_a_refused_job_ends_the_call() -> None:
    plane = FakeControlPlane(AgentNotResolved("does not belong to org"))
    meta = JobMeta.parse('{"orgId":"other","agentId":"agent-1"}')
    with pytest.raises(ResolutionFailed, match="refused"):
        await _resolve_from_meta(meta, plane)  # type: ignore[arg-type]


async def test_an_unreachable_control_plane_ends_the_call() -> None:
    """No fallback. Answering as the wrong agent is worse than not answering.

    A caller put through to another company's script would not know, and
    neither would the customer whose number it was.
    """
    plane = FakeControlPlane(RuntimeError("connection refused"))
    meta = JobMeta.parse('{"agentId":"agent-1"}')
    with pytest.raises(ResolutionFailed, match="could not resolve"):
        await _resolve_from_meta(meta, plane)  # type: ignore[arg-type]


async def test_an_unassigned_number_ends_the_call() -> None:
    plane = FakeControlPlane(AgentNotResolved("no assigned number"))
    with pytest.raises(ResolutionFailed, match="no agent answers"):
        await _resolve_by_number("+919999999999", plane)  # type: ignore[arg-type]


async def test_number_resolution_asks_by_number() -> None:
    plane = FakeControlPlane()
    await _resolve_by_number("+911111111111", plane)  # type: ignore[arg-type]
    assert plane.calls[0] == {"number": "+911111111111"}


# --- the resolved agent maps onto a config ----------------------------------


def test_a_resolved_agent_becomes_a_config_record() -> None:
    record = AGENT.as_record()
    assert record["prompt_mode"] == "verbatim"
    assert record["agent_slug"] == "simran"
    assert record["instructions"] == "You are Simran."


def test_prompt_mode_reaches_the_config() -> None:
    """The bug this guards: a verbatim script silently getting the shared rules.

    `prompt_mode` lives beside the prompt rather than inside the config blob,
    so it has to be carried through resolution explicitly.
    """
    from automitra_worker.config import AgentConfig
    from automitra_worker.personas import VOICE_BASE_RULES

    config = AgentConfig.from_record(AGENT.as_record())
    assert VOICE_BASE_RULES not in config.instructions
    assert config.instructions.startswith("You are Simran.")
