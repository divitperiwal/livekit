"""The Call itself, with a real AgentSession whose start is stubbed (no room, no audio)."""

import json
from types import SimpleNamespace

import pytest
from fake_control_plane import RESOLVED_AGENT, SECRET
from fake_job_context import FakeJobContext
from livekit.api.twirp_client import SipCallError

from automitra_worker.call import Call
from automitra_worker.control_plane.client import ControlPlaneClient
from automitra_worker.control_plane.contract import ResolveResponse
from automitra_worker.control_plane.resolution import JobMetadata, resolve_call
from automitra_worker.cost.call_cost_control import CallCostControl
from automitra_worker.telephony.settings import TelephonySettings

TELEPHONY = TelephonySettings.from_environment(
    {
        "TELEPHONY_ENABLED": "true",
        "PLIVO_PHONE_NUMBERS": "+911712345678",
        "PLIVO_SIP_USERNAME": "u",
        "PLIVO_SIP_PASSWORD": "p",
        "TELEPHONY_OUTBOUND_TRUNK_ID": "ST_out",
    }
)


class FakeVAD:
    def update_options(self, **options):
        self.options = options


class FakeRoom(SimpleNamespace):
    def on(self, event, callback=None):
        self.handlers = getattr(self, "handlers", {})
        self.handlers[event] = callback


class FakeSip:
    def __init__(self, error=None):
        self.error = error
        self.dialled = []

    async def create_sip_participant(self, request):
        self.dialled.append(request)
        if self.error:
            raise self.error


def job_context(sip: FakeSip, metadata: str = "") -> FakeJobContext:
    ctx = FakeJobContext(metadata=metadata)
    ctx.room = FakeRoom(name="call-room")
    ctx.proc.userdata["vad"] = FakeVAD()
    ctx.api = SimpleNamespace(sip=sip)
    return ctx


class Resolver:
    def __init__(self, config):
        self.answer = ResolveResponse.model_validate({**RESOLVED_AGENT, "config": config})

    async def resolve(self, **query):
        return self.answer


async def no_phone_leg():
    return None


@pytest.fixture(autouse=True)
def offline_session(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    from livekit.agents import AgentSession

    async def start(self, **options):
        return None

    monkeypatch.setattr(AgentSession, "start", start)


async def make_call(
    metadata_json: dict, config: dict, sip: FakeSip, client=None
) -> tuple[Call, FakeJobContext]:
    metadata = JobMetadata.parse(json.dumps(metadata_json))
    resolved = await resolve_call(metadata, Resolver(config), no_phone_leg)
    ctx = job_context(sip, json.dumps(metadata_json))
    cost_control = CallCostControl(
        resolved.runtime_agent.config, limit_inr=resolved.runtime_agent.config.budget_inr
    )
    call = Call(
        ctx,
        resolved.runtime_agent,
        cost_control,
        metadata=metadata,
        telephony=TELEPHONY,
        resolved=resolved,
        client=client,
    )
    return call, ctx


async def test_the_call_offers_the_tools_its_config_and_direction_call_for():
    inbound, _ = await make_call({"agentId": "a"}, {}, FakeSip())
    assert {tool.info.name for tool in inbound._assistant.tools} == {"end_call"}

    outbound, _ = await make_call(
        {"agentId": "a", "placeCall": True, "toNumber": "+919876543210"},
        {"transferTargets": [{"name": "Sales", "number": "+911712345678"}]},
        FakeSip(),
    )
    names = {tool.info.name for tool in outbound._assistant.tools}
    assert {"end_call", "transfer_call", "send_dtmf_events"} <= names


async def test_keypad_input_is_wired_only_when_enabled():
    _, with_keypad = await make_call({"agentId": "a"}, {}, FakeSip())
    _, without = await make_call({"agentId": "a"}, {"dtmfInput": False}, FakeSip())
    assert "sip_dtmf_received" in with_keypad.room.handlers
    assert not getattr(without.room, "handlers", {})


async def test_a_busy_outbound_call_is_recorded_unanswered_and_ends(fake_api):
    client = await ControlPlaneClient(fake_api.url, SECRET).open()
    sip = FakeSip(
        error=SipCallError("unavailable", "busy", status=503, metadata={"sip_status_code": "486"})
    )
    call, ctx = await make_call(
        {
            "agentId": "a",
            "placeCall": True,
            "toNumber": "+919876543210",
            "fromNumber": "+911712345678",
        },
        {"voicemailDetection": False},
        sip,
        client,
    )
    await call.run()

    assert sip.dialled[0].sip_call_to == "+919876543210" and sip.dialled[0].sip_trunk_id == "ST_out"
    assert (call.outcome.status, call.outcome.end_reason, call.outcome.answered) == (
        "busy",
        "sip_486",
        False,
    )
    assert ctx.shutdown_reasons == ["busy"]
    opened = fake_api.requests_to("/internal/calls")[0].body
    assert opened["answered"] is False and opened["direction"] == "outbound"

    for callback in ctx.shutdown_callbacks:
        await callback()
    finalized = fake_api.requests_to("/finalize")[0].body
    assert (finalized["status"], finalized["endReason"], finalized["durationSeconds"]) == (
        "busy",
        "sip_486",
        0,
    )
    assert finalized["usage"] is None


async def recording_call(monkeypatch, tmp_path, *, record_calls: bool = True):
    call, ctx = await make_call({"agentId": "a"}, {}, FakeSip())
    call._resolved.agent.record_calls = record_calls
    ctx.session_directory = str(tmp_path)
    return call


async def test_a_recorder_that_will_not_start_leaves_the_call_unrecorded_and_unannounced(
    monkeypatch, tmp_path
):
    from automitra_worker.reporting.recording import CallRecorder, RecordingStorage

    async def refuse(self, session):
        raise RuntimeError("no audio device")

    monkeypatch.setattr(CallRecorder, "start", refuse)
    call = await recording_call(monkeypatch, tmp_path)
    storage = RecordingStorage(
        bucket="b", region="blr1", access_key="a", secret_key="s", endpoint="https://x"
    )
    assert await call._start_recording_if_wanted(storage) is False
    assert call.report.recorder is None


async def test_recording_needs_the_org_to_opt_in_and_storage_to_exist(monkeypatch, tmp_path):
    from automitra_worker.reporting.recording import RecordingStorage

    storage = RecordingStorage(
        bucket="b", region="blr1", access_key="a", secret_key="s", endpoint="https://x"
    )
    assert (
        await (
            await recording_call(monkeypatch, tmp_path, record_calls=False)
        )._start_recording_if_wanted(storage)
        is False
    )
    monkeypatch.setattr(
        RecordingStorage, "from_environment", classmethod(lambda cls, environ=None: None)
    )
    assert await (await recording_call(monkeypatch, tmp_path))._start_recording_if_wanted() is False


async def test_the_post_call_step_analyses_answered_conversations_only(monkeypatch):
    from automitra_worker import call as call_module
    from automitra_worker.control_plane.contract import CallAnalysis
    from automitra_worker.reporting.analysis import AnalysisResult

    analysed = []

    async def fake_analyse(model, transcript, dispositions, fields, qa):
        analysed.append(transcript)
        return AnalysisResult(
            CallAnalysis(disposition="interested"), prompt_tokens=900, completion_tokens=60
        )

    monkeypatch.setattr(call_module, "analyse_call", fake_analyse)

    silent, _ = await make_call({"agentId": "a"}, {}, FakeSip())
    await silent._after_session()
    assert silent.report.analysis is None  # the caller never spoke

    voicemail, _ = await make_call({"agentId": "a"}, {}, FakeSip())
    voicemail._session.history.add_message(role="user", content="beep")
    voicemail.outcome.status = "voicemail"
    await voicemail._after_session()
    assert voicemail.report.analysis is None

    spoken, _ = await make_call({"agentId": "a"}, {}, FakeSip())
    spoken._session.history.add_message(role="assistant", content="नमस्कार")
    spoken._session.history.add_message(role="user", content="Thar ki price?")
    await spoken._after_session()
    assert analysed == ["Agent: नमस्कार\nCaller: Thar ki price?"]
    assert spoken.report.analysis.analysis.disposition == "interested"
