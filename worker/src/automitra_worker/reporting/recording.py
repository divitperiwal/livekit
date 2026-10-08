"""Recording a call, when the organisation has opted in.

The worker records the call itself: the SDK's RecorderIO taps the caller's audio in and
the agent's out, and writes stereo OGG/Opus (caller left, agent right) to the job's
scratch directory. When the call ends the file goes to the bucket in one signed PUT.

Not LiveKit Egress (billed per minute) and not `session.start(record=True)`, which on
LiveKit Cloud also uploads audio and transcripts to LiveKit's observability service: a
caller's voice goes to the bucket the organisation chose and nowhere else.

Only the object key is stored, never a URL, and only once the upload has succeeded, so
nobody is ever offered a recording that is not there. The API signs a short-lived URL
for each playback. `RecorderIO` is an SDK internal, so the SDK stays pinned at ~=1.8.
"""

import asyncio
import hashlib
import hmac
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote, urlsplit

import aiohttp
from yarl import URL

if TYPE_CHECKING:
    from livekit.agents import AgentSession
    from livekit.agents.voice.recorder_io import RecorderIO

logger = logging.getLogger("automitra.recording")

# An hour's call (~60 MB) on a slow uplink, without holding a dead endpoint for the
# whole session-end allowance.
UPLOAD_TIMEOUT = aiohttp.ClientTimeout(total=120, sock_connect=10)
# A phone line carries 8 kHz; 16 kHz loses nothing audible and is a fifth the size of 48.
RECORDING_SAMPLE_RATE = 16000


@dataclass(frozen=True)
class RecordingStorage:
    """Any S3-compatible bucket: DigitalOcean Spaces, AWS, R2, MinIO."""

    bucket: str
    region: str
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)
    # Empty for AWS itself; the endpoint for anything S3-compatible.
    endpoint: str = ""
    prefix: str = "recordings"

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] = os.environ) -> "RecordingStorage | None":
        """None when recording storage is not set up."""
        bucket = environ.get("RECORDING_S3_BUCKET", "").strip()
        access_key = environ.get("RECORDING_S3_ACCESS_KEY", "").strip()
        secret_key = environ.get("RECORDING_S3_SECRET_KEY", "").strip()
        if not (bucket and access_key and secret_key):
            return None
        return cls(
            bucket=bucket,
            region=environ.get("RECORDING_S3_REGION", "").strip() or "auto",
            access_key=access_key,
            secret_key=secret_key,
            endpoint=environ.get("RECORDING_S3_ENDPOINT", "").strip(),
            prefix=environ.get("RECORDING_S3_PREFIX", "").strip().strip("/") or "recordings",
        )

    @property
    def signing_region(self) -> str:
        """AWS has no "auto" region; a bucket on AWS with none set is us-east-1, as AWS does."""
        if self.region == "auto" and not self.endpoint:
            return "us-east-1"
        return self.region

    def object_url(self, key: str) -> str:
        """Percent-encoded once. Path-style for S3-compatible stores, virtual-hosted for AWS."""
        path = quote(key, safe="/-_.~")
        if self.endpoint:
            return f"{self.endpoint.rstrip('/')}/{quote(self.bucket, safe='-_.~')}/{path}"
        return f"https://{self.bucket}.s3.{self.signing_region}.amazonaws.com/{path}"


def recording_key(
    storage: RecordingStorage, org_id: str, room_name: str, now: datetime | None = None
) -> str:
    """Grouped by tenant, then month: one tenant's recordings can be found and deleted
    (on request, or when they leave) without listing anyone else's."""
    moment = now or datetime.now(UTC)
    return f"{storage.prefix}/{org_id}/{moment:%Y/%m}/{room_name}.ogg"


def sign_v4(
    *,
    method: str,
    url: str,
    headers: Mapping[str, str],
    payload_sha256: str,
    access_key: str,
    secret_key: str,
    region: str,
    now: datetime,
    service: str = "s3",
) -> str:
    """The Authorization header for AWS Signature Version 4. Every header passed is signed;
    `host` comes from the URL, whose path must already be percent-encoded. Written out
    rather than taken from boto: this is the only AWS-style call the worker makes."""
    parts = urlsplit(url)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    day = amz_date[:8]
    canonical_headers = {
        name.lower().strip(): " ".join(value.split()) for name, value in headers.items()
    }
    canonical_headers["host"] = parts.netloc
    names = sorted(canonical_headers)
    canonical_request = "\n".join(
        [
            method,
            parts.path or "/",
            parts.query,
            "".join(f"{name}:{canonical_headers[name]}\n" for name in names),
            ";".join(names),
            payload_sha256,
        ]
    )
    scope = f"{day}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signing_key = _hmac(
        _hmac(_hmac(_hmac(f"AWS4{secret_key}".encode(), day), region), service), "aws4_request"
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={';'.join(names)}, Signature={signature}"
    )


async def upload_recording(
    http: aiohttp.ClientSession,
    storage: RecordingStorage,
    key: str,
    data: bytes,
    *,
    now: datetime | None = None,
) -> bool:
    """Whether it landed. Never raises: losing a recording must not also lose the call's
    transcript and usage, which are finalised after this."""
    url = storage.object_url(key)
    moment = now or datetime.now(UTC)
    digest = hashlib.sha256(data).hexdigest()
    headers = {
        "content-type": "audio/ogg",
        "x-amz-content-sha256": digest,
        "x-amz-date": moment.strftime("%Y%m%dT%H%M%SZ"),
    }
    headers["authorization"] = sign_v4(
        method="PUT",
        url=url,
        headers=headers,
        payload_sha256=digest,
        access_key=storage.access_key,
        secret_key=storage.secret_key,
        region=storage.signing_region,
        now=moment,
    )
    try:
        # encoded=True: the path is sent exactly as signed, never re-encoded.
        async with http.put(
            URL(url, encoded=True), data=data, headers=headers, timeout=UPLOAD_TIMEOUT
        ) as response:
            if response.status >= 300:
                # S3's XML error body: a code and a message, no secrets.
                logger.error(
                    "recording upload to %s failed: HTTP %d %s",
                    key,
                    response.status,
                    (await response.text())[:300],
                )
                return False
    except (aiohttp.ClientError, TimeoutError) as error:
        logger.error("recording upload to %s failed: %r", key, error)
        return False
    logger.info("recording uploaded to %s (%d bytes)", key, len(data))
    return True


class CallRecorder:
    """One call's recording, from the moment someone answers to the upload."""

    def __init__(self, storage: RecordingStorage, key: str, path: Path) -> None:
        self.storage = storage
        self.key = key
        self.path = path
        self._recorder: "RecorderIO | None" = None
        self._finished: asyncio.Future[str | None] | None = None

    async def start(self, session: "AgentSession") -> bool:
        """Whether it started. Must run after `session.start`, which wires the room's
        audio to the session; the recorder then passes every frame through unchanged."""
        from livekit.agents.voice.recorder_io import RecorderIO

        if session.input.audio is None or session.output.audio is None:
            logger.error("cannot record: the session has no audio")
            return False
        recorder = RecorderIO(agent_session=session, sample_rate=RECORDING_SAMPLE_RATE)
        session.input.audio = recorder.record_input(session.input.audio)
        session.output.audio = recorder.record_output(session.output.audio)
        await recorder.start(output_path=self.path)
        self._recorder = recorder
        logger.info("recording to %s", self.key)
        return True

    async def finish(self, http: aiohttp.ClientSession) -> str | None:
        """The object key once uploaded, or None. Safe from both the session-end hook and
        a shutdown callback: the second caller waits for the first's result."""
        if self._finished is None:
            self._finished = asyncio.ensure_future(self._close_and_upload(http))
        return await asyncio.shield(self._finished)

    async def _close_and_upload(self, http: aiohttp.ClientSession) -> str | None:
        if self._recorder is None:
            return None
        try:
            await self._recorder.aclose()
            data = await asyncio.to_thread(self.path.read_bytes)
        except Exception:
            logger.exception("could not close the recording of %s", self.key)
            return None
        if not data:
            logger.warning("recording of %s is empty; not uploading", self.key)
            return None
        landed = await upload_recording(http, self.storage, self.key, data)
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass  # The job's scratch directory goes with the job anyway.
        return self.key if landed else None


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()
