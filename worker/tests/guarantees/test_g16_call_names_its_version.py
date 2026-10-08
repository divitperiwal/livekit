"""Guarantee 16, worker half: a call record names the exact agent version it ran. The API
half (versions never updated in place) is tested in the API."""

import json
from types import SimpleNamespace

from fake_control_plane import RESOLVED_AGENT

from automitra_worker.call import CallLine, open_call_request
from automitra_worker.control_plane.contract import OpenCallRequest, ResolveResponse
from automitra_worker.control_plane.resolution import JobMetadata, resolve_call
from automitra_worker.reporting.call_outcome import CallOutcome


class Resolver:
    async def resolve(self, **query):
        return ResolveResponse.model_validate(
            {**RESOLVED_AGENT, "agentVersionId": "version-live-12"}
        )


async def no_phone_leg():
    return None


async def test_the_opened_record_carries_the_version_resolution_returned():
    # Asked by agent: the API picks the live version (or an experiment's candidate); the
    # record must carry that pick, not just the agent.
    resolved = await resolve_call(
        JobMetadata.parse(json.dumps({"agentId": "agent-simran"})), Resolver(), no_phone_leg
    )
    ctx = SimpleNamespace(room=SimpleNamespace(name="room"), job=SimpleNamespace(id="job-1"))
    line = CallLine(direction=resolved.direction, caller_number=None, dialled_number=None)
    request = open_call_request(ctx, resolved, line, CallOutcome())
    assert request.agent_version_id == "version-live-12"


def test_a_call_record_cannot_be_opened_without_a_version():
    assert OpenCallRequest.model_fields["agent_version_id"].is_required()
