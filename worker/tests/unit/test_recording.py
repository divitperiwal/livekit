"""Signing is checked against AWS's own worked examples; uploads against a local bucket."""

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import aiohttp
import pytest

from automitra_worker.reporting.recording import (
    CallRecorder,
    RecordingStorage,
    recording_key,
    sign_v4,
    upload_recording,
)

# The credentials and date AWS's Signature Version 4 examples are worked with.
EXAMPLE_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"
EXAMPLE_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
EXAMPLE_DATE = datetime(2013, 5, 24, tzinfo=UTC)
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

SPACES = RecordingStorage(
    bucket="automitra-recordings",
    region="blr1",
    access_key="AK",
    secret_key="SK",
    endpoint="https://blr1.digitaloceanspaces.com",
)


def storage_at(endpoint: str) -> RecordingStorage:
    return RecordingStorage(
        bucket="calls", region="auto", access_key="AK", secret_key="SK", endpoint=endpoint
    )


class FakeRecorderIO:
    """Closing it writes the file once, as the SDK recorder does."""

    def __init__(self, path: Path, data: bytes) -> None:
        self.path, self.data, self.closed = path, data, 0

    async def aclose(self) -> None:
        self.closed += 1
        self.path.write_bytes(self.data)


def test_storage_is_off_until_bucket_and_both_keys_are_set():
    assert RecordingStorage.from_environment({}) is None
    assert (
        RecordingStorage.from_environment(
            {"RECORDING_S3_BUCKET": "b", "RECORDING_S3_ACCESS_KEY": "a"}
        )
        is None
    )
    configured = RecordingStorage.from_environment(
        {
            "RECORDING_S3_BUCKET": "automitra-recordings",
            "RECORDING_S3_ACCESS_KEY": "a",
            "RECORDING_S3_SECRET_KEY": "s",
            "RECORDING_S3_REGION": "blr1",
            "RECORDING_S3_ENDPOINT": "https://blr1.digitaloceanspaces.com",
        }
    )
    assert configured.signing_region == "blr1" and configured.prefix == "recordings"


def test_credentials_never_appear_in_repr():
    assert "SK" not in repr(SPACES) and "'AK'" not in repr(SPACES)


def test_keys_group_by_tenant_then_month():
    at = datetime(2026, 10, 4, tzinfo=UTC)
    assert (
        recording_key(SPACES, "org-kbs", "call-abc", at)
        == "recordings/org-kbs/2026/10/call-abc.ogg"
    )


def test_digitalocean_spaces_uses_path_style_addressing_and_its_region():
    assert SPACES.object_url("recordings/o/x.ogg") == (
        "https://blr1.digitaloceanspaces.com/automitra-recordings/recordings/o/x.ogg"
    )
    assert SPACES.signing_region == "blr1"


def test_aws_itself_uses_virtual_hosted_addressing_and_defaults_to_us_east_1():
    assert RecordingStorage(
        bucket="b", region="ap-south-1", access_key="a", secret_key="s"
    ).object_url("k.ogg") == ("https://b.s3.ap-south-1.amazonaws.com/k.ogg")
    assert (
        RecordingStorage(bucket="b", region="auto", access_key="a", secret_key="s").signing_region
        == "us-east-1"
    )


def test_keys_are_percent_encoded_exactly_once():
    assert SPACES.object_url("r/call_+9198.ogg").endswith("/r/call_%2B9198.ogg")


def test_signature_matches_the_aws_worked_example_for_get_object():
    authorization = sign_v4(
        method="GET",
        url="https://examplebucket.s3.amazonaws.com/test.txt",
        headers={
            "range": "bytes=0-9",
            "x-amz-content-sha256": EMPTY_SHA256,
            "x-amz-date": "20130524T000000Z",
        },
        payload_sha256=EMPTY_SHA256,
        access_key=EXAMPLE_ACCESS_KEY,
        secret_key=EXAMPLE_SECRET_KEY,
        region="us-east-1",
        now=EXAMPLE_DATE,
    )
    assert authorization == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )


def test_signature_matches_the_aws_worked_example_for_put_object():
    digest = hashlib.sha256(b"Welcome to Amazon S3.").hexdigest()
    authorization = sign_v4(
        method="PUT",
        url="https://examplebucket.s3.amazonaws.com/test%24file.text",
        headers={
            "date": "Fri, 24 May 2013 00:00:00 GMT",
            "x-amz-date": "20130524T000000Z",
            "x-amz-storage-class": "REDUCED_REDUNDANCY",
            "x-amz-content-sha256": digest,
        },
        payload_sha256=digest,
        access_key=EXAMPLE_ACCESS_KEY,
        secret_key=EXAMPLE_SECRET_KEY,
        region="us-east-1",
        now=EXAMPLE_DATE,
    )
    assert authorization.endswith(
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
    )


async def test_an_upload_puts_the_object_signed_at_its_key(fake_bucket):
    async with aiohttp.ClientSession() as http:
        assert await upload_recording(
            http, storage_at(fake_bucket.endpoint), "recordings/o/call_+91.ogg", b"OggS-audio"
        )
    request = fake_bucket.requests[0]
    assert request.raw_path == "/calls/recordings/o/call_%2B91.ogg"
    assert fake_bucket.objects["/calls/recordings/o/call_%2B91.ogg"] == b"OggS-audio"
    assert request.headers["Content-Type"] == "audio/ogg"
    assert request.headers["x-amz-content-sha256"] == hashlib.sha256(b"OggS-audio").hexdigest()
    assert "/auto/s3/aws4_request" in request.headers["Authorization"]


async def test_a_refused_or_unreachable_upload_reports_failure_without_raising(fake_bucket):
    async with aiohttp.ClientSession() as http:
        assert not await upload_recording(
            http, storage_at(fake_bucket.endpoint), "recordings/denied.ogg", b"x"
        )
        assert not await upload_recording(http, storage_at("http://127.0.0.1:9"), "k.ogg", b"x")
    assert fake_bucket.objects == {}


async def test_finishing_uploads_once_returns_the_key_and_removes_the_file(fake_bucket, tmp_path):
    recorder = CallRecorder(
        storage_at(fake_bucket.endpoint), "recordings/o/r.ogg", tmp_path / "recording.ogg"
    )
    sdk_recorder = FakeRecorderIO(recorder.path, b"OggS")
    recorder._recorder = sdk_recorder
    async with aiohttp.ClientSession() as http:
        # The session-end hook and the shutdown callback both finish it.
        assert await recorder.finish(http) == "recordings/o/r.ogg"
        assert await recorder.finish(http) == "recordings/o/r.ogg"
    assert sdk_recorder.closed == 1 and len(fake_bucket.requests) == 1
    assert not recorder.path.exists()


async def test_an_empty_or_never_started_recording_uploads_nothing(fake_bucket, tmp_path):
    never_started = CallRecorder(
        storage_at(fake_bucket.endpoint), "recordings/o/a.ogg", tmp_path / "a.ogg"
    )
    empty = CallRecorder(storage_at(fake_bucket.endpoint), "recordings/o/b.ogg", tmp_path / "b.ogg")
    empty._recorder = FakeRecorderIO(empty.path, b"")
    async with aiohttp.ClientSession() as http:
        assert await never_started.finish(http) is None
        assert await empty.finish(http) is None
    assert fake_bucket.requests == []
