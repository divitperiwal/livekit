import pytest
from fake_control_plane import RESOLVED_AGENT
from fake_job_context import FakeJobContext

from automitra_worker import call as call_module
from automitra_worker.control_plane.contract import ResolveResponse
from automitra_worker.control_plane.resolution import JobMetadata, resolve_call


class Resolver:
    def __init__(self, **overrides) -> None:
        self.answer = ResolveResponse.model_validate({**RESOLVED_AGENT, **overrides})

    async def resolve(self, **query):
        return self.answer


async def no_phone_leg():
    return None


@pytest.fixture
def session_never_built(monkeypatch):
    def build_session(*args, **kwargs):
        raise AssertionError("the call was answered")

    monkeypatch.setattr(call_module, "build_session", build_session)


@pytest.mark.parametrize("available_inr", [0.0, -3.5])
async def test_an_account_with_no_credit_is_refused_rather_than_run_unbounded(
    session_never_built, available_inr
):
    # A budget of 0 means "off": capping to Rs 0 must refuse, not switch the limit off.
    resolved = await resolve_call(
        JobMetadata(agent_id="a"), Resolver(availableInr=available_inr), no_phone_leg
    )
    ctx = FakeJobContext()
    await call_module.run_call(ctx, resolved.runtime_agent, resolved=resolved)
    assert ctx.shutdown_reasons == ["no credit"]


async def test_credit_too_small_to_hold_a_conversation_is_refused_before_answering(
    session_never_built,
):
    resolved = await resolve_call(
        JobMetadata(agent_id="a"), Resolver(availableInr=1.0), no_phone_leg
    )
    ctx = FakeJobContext()
    await call_module.run_call(ctx, resolved.runtime_agent, resolved=resolved)
    assert ctx.shutdown_reasons == ["call budget too small"]
