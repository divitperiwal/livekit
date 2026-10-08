"""Just enough of a LiveKit JobContext to run the entrypoint's decisions without a room."""

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any


@dataclass
class FakeJobContext:
    metadata: str = ""
    job_id: str = "job-1"
    room_name: str = "call-room-1"
    phone_participant: Any = None
    shutdown_reasons: list[str] = field(default_factory=list)
    shutdown_callbacks: list[Any] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.job = SimpleNamespace(id=self.job_id, metadata=self.metadata)
        self.room = SimpleNamespace(name=self.room_name)
        self.proc = SimpleNamespace(userdata={})

    def shutdown(self, reason: str = "") -> None:
        self.shutdown_reasons.append(reason)

    def add_shutdown_callback(self, callback: Any) -> None:
        self.shutdown_callbacks.append(callback)

    async def connect(self) -> None:
        pass

    async def wait_for_participant(self, **_: Any) -> Any:
        return self.phone_participant

    async def delete_room(self) -> None:
        pass
