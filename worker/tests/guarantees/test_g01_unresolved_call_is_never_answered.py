"""Guarantee 1: a call that cannot be resolved is ended, never answered with a fallback
configuration. Run through the real entrypoint against a fake API."""

import json

import pytest
from fake_control_plane import SECRET
from fake_job_context import FakeJobContext

from automitra_worker import entrypoint as worker_entrypoint


@pytest.fixture
def multi_tenant(monkeypatch, fake_api):
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    monkeypatch.setenv("CONTROL_PLANE_URL", fake_api.url)
    # A fallback would show up as the environment's agent being run.
    monkeypatch.setenv("AGENT_PERSONA", "kbs")
    calls_run: list = []

    async def run_call(ctx, runtime_agent, **kwargs):
        calls_run.append(runtime_agent)

    monkeypatch.setattr(worker_entrypoint, "run_call", run_call)
    return calls_run


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (404, "agent could not be resolved"),
        (403, "agent could not be resolved"),
        (500, "agent could not be resolved"),
        (402, "out of credit"),
    ],
)
async def test_a_refused_call_is_shut_down_and_never_run(fake_api, multi_tenant, status, reason):
    fake_api.resolve_status = status
    ctx = FakeJobContext(metadata=json.dumps({"agentId": "agent-simran", "orgId": "org-other"}))
    await worker_entrypoint.entrypoint(ctx)
    assert ctx.shutdown_reasons == [reason]
    assert multi_tenant == []


async def test_an_unreachable_api_ends_the_call(monkeypatch, multi_tenant):
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    ctx = FakeJobContext(metadata=json.dumps({"agentId": "agent-simran"}))
    await worker_entrypoint.entrypoint(ctx)
    assert ctx.shutdown_reasons == ["agent could not be resolved"]
    assert multi_tenant == []


async def test_a_job_with_nothing_to_resolve_against_ends_the_call(multi_tenant):
    ctx = FakeJobContext(metadata="", phone_participant=None)
    await worker_entrypoint.entrypoint(ctx)
    assert ctx.shutdown_reasons == ["agent could not be resolved"]
    assert multi_tenant == []


async def test_a_resolved_call_runs_the_resolved_agent_not_the_environments(fake_api, multi_tenant):
    ctx = FakeJobContext(
        metadata=json.dumps({"agentId": "agent-simran", "variables": {"name": "Asha"}})
    )
    await worker_entrypoint.entrypoint(ctx)
    assert ctx.shutdown_reasons == []
    (runtime_agent,) = multi_tenant
    assert runtime_agent.name == "simran"
    assert "Caller: Asha." in runtime_agent.instructions
