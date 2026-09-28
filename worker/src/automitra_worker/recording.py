"""Recording a call, when the organisation has opted in.

LiveKit Egress mixes the room's audio -- caller and agent together -- and
writes one OGG file straight to object storage. The worker only asks for it to
start; the file lands in the bucket without passing through this process, and
egress stops by itself when the room is deleted at the end of the call.

What is stored on the call record is the object key, never a URL. A URL
outlives its purpose, leaks through logs and cannot be revoked; the control
plane signs a short-lived one each time someone presses play.

Storage is configured on the worker because egress needs credentials that
can write, and the control plane only ever needs ones that can read.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

from livekit import api

logger = logging.getLogger("automitra.recording")

DISCLOSURE_INSTRUCTIONS = (
    "In the same opening, tell the caller in a few words that this call is "
    "recorded, in the language you are speaking."
)


@dataclass(frozen=True)
class RecordingStorage:
    """An S3-compatible bucket: AWS, Cloudflare R2, MinIO and the like."""

    bucket: str
    region: str
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)
    # Empty for AWS itself; the endpoint URL for anything S3-compatible.
    endpoint: str = ""
    prefix: str = "recordings"

    @classmethod
    def from_env(cls) -> RecordingStorage | None:
        """The configured bucket, or None when recording storage is not set up."""
        bucket = os.getenv("RECORDING_S3_BUCKET", "").strip()
        access = os.getenv("RECORDING_S3_ACCESS_KEY", "").strip()
        secret = os.getenv("RECORDING_S3_SECRET_KEY", "").strip()
        if not (bucket and access and secret):
            return None
        return cls(
            bucket=bucket,
            region=os.getenv("RECORDING_S3_REGION", "").strip() or "auto",
            access_key=access,
            secret_key=secret,
            endpoint=os.getenv("RECORDING_S3_ENDPOINT", "").strip(),
            prefix=os.getenv("RECORDING_S3_PREFIX", "").strip().strip("/") or "recordings",
        )


def recording_key(storage: RecordingStorage, org_id: str, room_name: str, now: datetime | None = None) -> str:
    """Where a call's recording goes: grouped by tenant, then by month.

    Grouping by organisation first is what lets one tenant's recordings be
    found -- and deleted, on request or when they close their account --
    without listing everyone else's.
    """
    now = now or datetime.now(timezone.utc)
    return f"{storage.prefix}/{org_id}/{now:%Y/%m}/{room_name}.ogg"


def egress_request(room_name: str, key: str, storage: RecordingStorage) -> api.RoomCompositeEgressRequest:
    s3 = api.S3Upload(
        access_key=storage.access_key,
        secret=storage.secret_key,
        region=storage.region,
        bucket=storage.bucket,
        endpoint=storage.endpoint,
        # Anything S3-compatible that is not AWS generally wants path-style
        # addressing; AWS itself wants virtual-hosted.
        force_path_style=bool(storage.endpoint),
    )
    return api.RoomCompositeEgressRequest(
        room_name=room_name,
        audio_only=True,
        file_outputs=[
            api.EncodedFileOutput(
                file_type=api.EncodedFileType.OGG,
                filepath=key,
                s3=s3,
                # One object per call; the manifest is not needed.
                disable_manifest=True,
            )
        ],
    )


async def start_recording(
    lk: api.LiveKitAPI, room_name: str, org_id: str, storage: RecordingStorage
) -> str | None:
    """Start recording the room. Returns the object key, or None if it failed.

    A failure is logged and the call goes on unrecorded. Dropping a customer's
    call because the recorder would not start trades a compliance nicety for
    an outage.
    """
    key = recording_key(storage, org_id, room_name)
    try:
        await lk.egress.start_room_composite_egress(egress_request(room_name, key, storage))
    except Exception as exc:
        logger.error("could not start recording %s: %s", room_name, exc)
        return None
    logger.info("recording to %s", key)
    return key
