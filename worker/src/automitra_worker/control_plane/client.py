"""The worker's only way to the API, and two failure policies.

Resolution happens before the agent says anything, and there is no safe fallback:
answering with some other configuration puts a caller through to the wrong company's
script. So resolution failing raises, and the call is ended unanswered.

Writes happen while a call is working. Dropping a call because a transcript could not be
written turns a reporting problem into an outage, so write failures are logged and
swallowed. Every write is idempotent, so a later retry can still land what one lost.
"""

import logging
from typing import Any

import aiohttp
from pydantic import BaseModel, ValidationError

from automitra_worker.control_plane.contract import (
    INTERNAL_SECRET_HEADER,
    AppendEventsRequest,
    AppendEventsResponse,
    CallEvent,
    FinalizeCallRequest,
    FinalizeCallResponse,
    OpenCallRequest,
    OpenCallResponse,
    ResolveResponse,
)

logger = logging.getLogger("automitra.control_plane")

# A caller is waiting through resolution: fail fast rather than hold the line silent.
RESOLVE_TIMEOUT_SECONDS = 3.0
WRITE_TIMEOUT_SECONDS = 5.0


class ControlPlaneUnavailable(RuntimeError):
    """The API could not be reached, or answered with something unexpected."""


class CallRefused(RuntimeError):
    """The API answered and said no (403 tenant mismatch, 404 nothing matches)."""


class OutOfCredit(CallRefused):
    """402: the account or org cannot pay. A business refusal, not a fault."""


class ControlPlaneClient:
    """Owns one HTTP session for the life of a call. The call's last writes run in a
    shutdown callback after the entrypoint returns, so whoever opens it closes it."""

    def __init__(
        self, base_url: str, secret: str, session: aiohttp.ClientSession | None = None
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._secret = secret
        self._session = session
        self._owns_session = session is None

    async def open(self) -> "ControlPlaneClient":
        if self._session is None:
            self._session = aiohttp.ClientSession(headers={INTERNAL_SECRET_HEADER: self._secret})
        return self

    async def aclose(self) -> None:
        """Safe to call more than once."""
        if self._owns_session and self._session is not None:
            await self._session.close()
            self._session = None

    async def resolve(
        self,
        *,
        agent_version_id: str | None = None,
        agent_id: str | None = None,
        number: str | None = None,
        org_id: str | None = None,
    ) -> ResolveResponse:
        """Raises rather than returning a default: no configuration is safe to guess."""
        if agent_version_id:
            query = {"agentVersionId": agent_version_id}
        elif agent_id:
            query = {"agentId": agent_id}
        elif number:
            query = {"number": number}
        else:
            raise ValueError("resolve needs a version, an agent or a number")
        if org_id:
            query["orgId"] = org_id

        try:
            async with self._require_session().get(
                f"{self._base_url}/internal/resolve",
                params=query,
                timeout=aiohttp.ClientTimeout(total=RESOLVE_TIMEOUT_SECONDS),
            ) as response:
                if response.status == 200:
                    return ResolveResponse.model_validate(await response.json())
                detail = await _error_detail(response)
                if response.status == 402:
                    raise OutOfCredit(detail)
                if response.status in (403, 404):
                    raise CallRefused(detail)
                raise ControlPlaneUnavailable(f"resolve returned {response.status}: {detail}")
        except (aiohttp.ClientError, TimeoutError) as error:
            raise ControlPlaneUnavailable(
                f"could not reach the control plane: {error!r}"
            ) from error
        except ValidationError as error:
            raise ControlPlaneUnavailable(
                f"resolve answered with an unexpected body: {error}"
            ) from error

    async def open_call(self, request: OpenCallRequest) -> OpenCallResponse | None:
        return await self._write(
            "/internal/calls", request, OpenCallResponse, purpose="open a call record"
        )

    async def append_events(
        self, call_id: str, org_id: str, events: list[CallEvent]
    ) -> AppendEventsResponse | None:
        if not events:
            return None
        return await self._write(
            f"/internal/calls/{call_id}/events",
            AppendEventsRequest(org_id=org_id, events=events),
            AppendEventsResponse,
            purpose="write call events",
        )

    async def finalize_call(
        self, call_id: str, request: FinalizeCallRequest
    ) -> FinalizeCallResponse | None:
        return await self._write(
            f"/internal/calls/{call_id}/finalize",
            request,
            FinalizeCallResponse,
            purpose="finalize a call",
        )

    async def _write[Response: BaseModel](
        self, path: str, request: BaseModel, response_model: type[Response], *, purpose: str
    ) -> Response | None:
        try:
            async with self._require_session().post(
                f"{self._base_url}{path}",
                json=request.model_dump(mode="json", by_alias=True),
                timeout=aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS),
            ) as response:
                if response.status < 300:
                    return response_model.model_validate(await response.json())
                logger.warning(
                    "could not %s: %s returned %s (%s)",
                    purpose,
                    path,
                    response.status,
                    await _error_detail(response),
                )
        except Exception as error:
            logger.warning("could not %s: %r", purpose, error)
        return None

    def _require_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            raise ControlPlaneUnavailable("the client is not open")
        return self._session


async def _error_detail(response: aiohttp.ClientResponse) -> str:
    try:
        body: Any = await response.json()
        return str(body.get("error") or body)
    except Exception:
        return (await response.text())[:200]
