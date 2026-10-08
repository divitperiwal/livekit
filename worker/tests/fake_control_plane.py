"""An in-process stand-in for the API's /internal/* routes.

It checks the secret header and validates every request body against the contract, so a
client that sends the wrong shape fails here the way it would against the real API.
"""

import json
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web
from pydantic import BaseModel, ValidationError

from automitra_worker.control_plane.contract import (
    INTERNAL_SECRET_HEADER,
    AppendEventsRequest,
    FinalizeCallRequest,
    OpenCallRequest,
)

SECRET = "test-internal-secret"

RESOLVED_AGENT = {
    "orgId": "org-kbs",
    "agentId": "agent-simran",
    "agentVersionId": "version-7",
    "agentSlug": "simran",
    "promptMode": "prepend_base_rules",
    "instructions": "You answer for KBS Motors. Caller: {{name|ji}}.",
    "greeting": "Greet the caller.",
    "config": {"ttsSpeaker": "priya", "budgetInr": 20},
    "recordCalls": False,
    "availableInr": 150.0,
}


@dataclass
class Received:
    method: str
    path: str
    query: dict[str, str]
    secret: str | None
    body: Any


@dataclass
class FakeControlPlane:
    resolve_status: int = 200
    resolve_body: dict[str, Any] = field(default_factory=lambda: dict(RESOLVED_AGENT))
    write_status: int = 200
    received: list[Received] = field(default_factory=list)
    url: str = ""

    def requests_to(self, path_suffix: str) -> list[Received]:
        return [request for request in self.received if request.path.endswith(path_suffix)]

    @property
    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/internal/resolve", self._resolve)
        app.router.add_post("/internal/calls", self._open_call)
        app.router.add_post("/internal/calls/{call_id}/events", self._append_events)
        app.router.add_post("/internal/calls/{call_id}/finalize", self._finalize)
        return app

    async def _receive(self, request: web.Request) -> Received:
        body = await request.json() if request.can_read_body else None
        received = Received(
            request.method,
            request.path,
            dict(request.query),
            request.headers.get(INTERNAL_SECRET_HEADER),
            body,
        )
        self.received.append(received)
        return received

    async def _resolve(self, request: web.Request) -> web.Response:
        received = await self._receive(request)
        if received.secret != SECRET:
            return web.json_response({"error": "bad secret"}, status=401)
        if self.resolve_status != 200:
            return web.json_response(
                {"error": f"refused with {self.resolve_status}"}, status=self.resolve_status
            )
        return web.json_response(self.resolve_body)

    async def _open_call(self, request: web.Request) -> web.Response:
        return await self._write(
            request, OpenCallRequest, lambda body: {"id": "call-1", "orgId": body["orgId"]}
        )

    async def _append_events(self, request: web.Request) -> web.Response:
        return await self._write(
            request, AppendEventsRequest, lambda body: {"inserted": len(body["events"])}
        )

    async def _finalize(self, request: web.Request) -> web.Response:
        return await self._write(
            request,
            FinalizeCallRequest,
            lambda body: {"id": request.match_info["call_id"], "status": body["status"]},
        )

    async def _write(
        self, request: web.Request, model: type[BaseModel], answer: Any
    ) -> web.Response:
        received = await self._receive(request)
        if received.secret != SECRET:
            return web.json_response({"error": "bad secret"}, status=401)
        try:
            model.model_validate(received.body, by_alias=True, by_name=False)
        except ValidationError as error:
            return web.json_response({"error": json.loads(error.json())}, status=422)
        if self.write_status != 200:
            return web.json_response({"error": "unavailable"}, status=self.write_status)
        return web.json_response(answer(received.body))
