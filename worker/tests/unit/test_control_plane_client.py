import pytest
from fake_control_plane import SECRET

from automitra_worker.control_plane.client import (
    CallRefused,
    ControlPlaneClient,
    ControlPlaneUnavailable,
    OutOfCredit,
)
from automitra_worker.control_plane.contract import CallEvent, FinalizeCallRequest, OpenCallRequest

OPEN_CALL = OpenCallRequest(
    org_id="org-kbs",
    agent_id="agent-simran",
    agent_version_id="version-7",
    lk_room_name="room",
    lk_job_id="job-1",
    direction="inbound",
)


@pytest.fixture
async def client(fake_api):
    client = await ControlPlaneClient(fake_api.url, SECRET).open()
    yield client
    await client.aclose()


async def test_resolve_sends_the_secret_and_asks_by_version_with_the_org_as_a_claim(
    fake_api, client
):
    agent = await client.resolve(agent_version_id="version-7", agent_id="ignored", org_id="org-kbs")
    request = fake_api.requests_to("/resolve")[0]
    assert request.secret == SECRET
    assert request.query == {"agentVersionId": "version-7", "orgId": "org-kbs"}
    assert (agent.org_id, agent.agent_version_id, agent.available_inr) == (
        "org-kbs",
        "version-7",
        150.0,
    )


async def test_resolve_can_ask_by_dialled_number(fake_api, client):
    await client.resolve(number="+911712345678")
    assert fake_api.requests_to("/resolve")[0].query == {"number": "+911712345678"}


@pytest.mark.parametrize(
    ("status", "error"),
    [(402, OutOfCredit), (403, CallRefused), (404, CallRefused), (500, ControlPlaneUnavailable)],
)
async def test_resolve_refusals_raise_by_kind(fake_api, client, status, error):
    fake_api.resolve_status = status
    with pytest.raises(error):
        await client.resolve(agent_id="agent-simran")


async def test_an_unexpected_resolve_body_raises_rather_than_guessing(fake_api, client):
    fake_api.resolve_body = {"orgId": "org-kbs"}
    with pytest.raises(ControlPlaneUnavailable, match="unexpected body"):
        await client.resolve(agent_id="agent-simran")


async def test_an_unreachable_api_raises_on_resolve():
    client = await ControlPlaneClient("http://127.0.0.1:9", SECRET).open()
    try:
        with pytest.raises(ControlPlaneUnavailable):
            await client.resolve(agent_id="agent-simran")
    finally:
        await client.aclose()


async def test_writes_send_camel_case_bodies_the_contract_accepts(fake_api, client):
    opened = await client.open_call(OPEN_CALL)
    assert opened.id == "call-1"
    body = fake_api.requests_to("/internal/calls")[0].body
    assert body["agentVersionId"] == "version-7" and body["lkJobId"] == "job-1"


async def test_write_failures_are_swallowed_not_raised(fake_api, client):
    fake_api.write_status = 503
    assert await client.open_call(OPEN_CALL) is None
    events = [
        CallEvent(seq=1, type="user_message", role="user", content="hi", at="2026-10-04T00:00:00Z")
    ]
    assert await client.append_events("call-1", "org-kbs", events) is None
    assert (
        await client.finalize_call(
            "call-1", FinalizeCallRequest(status="completed", duration_seconds=5)
        )
        is None
    )


async def test_an_unreachable_api_does_not_raise_on_writes():
    client = await ControlPlaneClient("http://127.0.0.1:9", SECRET).open()
    try:
        assert await client.open_call(OPEN_CALL) is None
    finally:
        await client.aclose()


async def test_no_events_means_no_request(fake_api, client):
    assert await client.append_events("call-1", "org-kbs", []) is None
    assert fake_api.received == []


async def test_closing_twice_is_safe_and_a_closed_client_raises_on_resolve(fake_api):
    client = await ControlPlaneClient(fake_api.url, SECRET).open()
    await client.aclose()
    await client.aclose()
    with pytest.raises(ControlPlaneUnavailable):
        await client.resolve(agent_id="agent-simran")
