"""Guarantee 20: a recording key is stored only after the upload succeeds, and a recorded
call always announces it."""

import aiohttp
import pytest
from cost_fakes import MODELS

from automitra_worker.cost.call_budget import CallBudget
from automitra_worker.cost.usage_meter import UsageMeter
from automitra_worker.pipeline.greeting import DISCLOSURE_INSTRUCTIONS, plan_opening
from automitra_worker.reporting.call_outcome import CallOutcome
from automitra_worker.reporting.finalize import finalize_request
from automitra_worker.reporting.recording import CallRecorder, RecordingStorage


class FakeRecorderIO:
    def __init__(self, path, data: bytes) -> None:
        self.path, self.data = path, data

    async def aclose(self) -> None:
        self.path.write_bytes(self.data)


async def finished_key(endpoint: str, key: str, tmp_path) -> str | None:
    storage = RecordingStorage(
        bucket="calls", region="auto", access_key="AK", secret_key="SK", endpoint=endpoint
    )
    recorder = CallRecorder(storage, key, tmp_path / "recording.ogg")
    recorder._recorder = FakeRecorderIO(recorder.path, b"OggS-audio")
    async with aiohttp.ClientSession() as http:
        return await recorder.finish(http)


def finalized(recording_key: str | None):
    return finalize_request(
        outcome=CallOutcome(),
        budget=CallBudget(limit_inr=0, **MODELS),
        close_reason="user_initiated",
        duration_seconds=60,
        latency=None,
        usage=UsageMeter(),
        recording_key=recording_key,
    )


async def test_a_successful_upload_puts_the_key_on_the_call(fake_bucket, tmp_path):
    key = await finished_key(fake_bucket.endpoint, "recordings/org/2026/10/call.ogg", tmp_path)
    assert finalized(key).recording_key == "recordings/org/2026/10/call.ogg"
    assert fake_bucket.objects


@pytest.mark.parametrize("where", ["refused", "unreachable"])
async def test_a_failed_upload_leaves_the_call_with_no_key(fake_bucket, tmp_path, where):
    endpoint = fake_bucket.endpoint if where == "refused" else "http://127.0.0.1:9"
    key = await finished_key(endpoint, "recordings/org/denied.ogg", tmp_path)
    assert key is None and finalized(key).recording_key is None


@pytest.mark.parametrize("mode", ["instructions", "verbatim"])
@pytest.mark.parametrize("language", ["hi-IN", "en-IN", "ta-IN", "unknown"])
def test_a_recorded_call_always_announces_it(mode, language):
    opening = plan_opening("नमस्कार, KBS Motors।", mode=mode, recorded=True, language=language)
    announced_in_words = opening.text is not None and opening.text != "नमस्कार, KBS Motors।"
    asked_of_the_model = (
        opening.instructions is not None and DISCLOSURE_INSTRUCTIONS in opening.instructions
    )
    assert announced_in_words or asked_of_the_model


def test_an_unrecorded_call_does_not_claim_to_be_recorded():
    for mode in ("instructions", "verbatim"):
        opening = plan_opening("नमस्कार", mode=mode, recorded=False, language="hi-IN")
        assert opening.text in (None, "नमस्कार")
        assert DISCLOSURE_INSTRUCTIONS not in (opening.instructions or "")
