"""The worker's client for the control plane.

The worker holds no database credentials and owns no schema. It asks the API
for the configuration a call should run on, and tells the API what the call
did. This module is that conversation.

Two different failure policies, because the two directions fail differently.

A resolution failure happens *before* the agent can say anything, and there is
no safe way to carry on: answering with a fallback configuration would put a
caller through to the wrong company's script without either of them knowing.
So resolution failing ends the call, loudly.

A persistence failure happens while a call is already working. Dropping the
call because a transcript could not be written would turn a reporting problem
into an outage, so those failures are logged and swallowed.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import aiohttp

logger = logging.getLogger("automitra.control_plane")

DEFAULT_BASE_URL = "http://localhost:3000"

# Short by the standards of an HTTP client, because a caller is waiting through
# this. Better to fail a call quickly and visibly than to hold an answered line
# in silence while a request that is not coming back times out.
RESOLVE_TIMEOUT_SECONDS = 3.0
WRITE_TIMEOUT_SECONDS = 5.0


class ControlPlaneError(RuntimeError):
    """The control plane could not answer."""


class AgentNotResolved(ControlPlaneError):
    """No agent configuration could be found for this call.

    Distinct from a transport failure: this means the control plane answered
    and said no. Retrying will not help.
    """


@dataclass(frozen=True)
class ResolvedAgent:
    """What the control plane says a call should run on."""

    org_id: str
    agent_id: str
    agent_version_id: str
    agent_slug: str
    prompt_mode: str
    instructions: str
    greeting: str
    config: dict[str, Any]
    record_calls: bool

    def as_record(self) -> dict[str, Any]:
        """The shape ``AgentConfig.from_record`` expects."""
        return {
            "agent_slug": self.agent_slug,
            "prompt_mode": self.prompt_mode,
            "instructions": self.instructions,
            "greeting": self.greeting,
            "config": self.config,
        }


class ControlPlane:
    """A thin client over the internal API.

    Owns one session for the life of a call, so the several requests a call
    makes share a connection rather than opening one each.
    """

    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        self._base_url = (base_url or os.getenv("CONTROL_PLANE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self._secret = secret or os.getenv("INTERNAL_API_SECRET") or ""
        self._session = session
        self._owned = session is None

    @property
    def configured(self) -> bool:
        """Whether a control plane is available at all.

        Unset means this is a local development run with no API, and the
        worker falls back to environment configuration.
        """
        return bool(self._secret)

    async def __aenter__(self) -> ControlPlane:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                headers={"x-internal-secret": self._secret}
            )
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._owned and self._session is not None:
            await self._session.close()
            self._session = None

    def _require_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            raise ControlPlaneError("use ControlPlane as an async context manager")
        return self._session

    # --- resolution ---------------------------------------------------------

    async def resolve(
        self,
        *,
        agent_version_id: str | None = None,
        agent_id: str | None = None,
        number: str | None = None,
        org_id: str | None = None,
    ) -> ResolvedAgent:
        """Ask which agent a call should run as.

        Raises rather than returning a default. There is no configuration that
        is safe to guess at here.
        """
        params: dict[str, str] = {}
        if agent_version_id:
            params["agentVersionId"] = agent_version_id
        elif agent_id:
            params["agentId"] = agent_id
        elif number:
            params["number"] = number
        else:
            raise ValueError("resolve needs a version, an agent or a number")
        if org_id:
            params["orgId"] = org_id

        session = self._require_session()
        try:
            async with session.get(
                f"{self._base_url}/internal/resolve",
                params=params,
                timeout=aiohttp.ClientTimeout(total=RESOLVE_TIMEOUT_SECONDS),
            ) as response:
                if response.status == 200:
                    return _resolved(await response.json())
                detail = await _error_detail(response)
                if response.status in (403, 404, 409):
                    raise AgentNotResolved(detail)
                raise ControlPlaneError(f"resolve returned {response.status}: {detail}")
        except aiohttp.ClientError as exc:
            raise ControlPlaneError(f"could not reach the control plane: {exc}") from exc
        except TimeoutError as exc:
            raise ControlPlaneError(
                f"the control plane did not answer within {RESOLVE_TIMEOUT_SECONDS}s"
            ) from exc

    # --- call records -------------------------------------------------------

    async def start_call(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        """Open a call record. Returns None if it could not be written."""
        return await self._post("/internal/calls", payload, what="open a call record")

    async def append_events(
        self, call_id: str, org_id: str, events: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        if not events:
            return None
        return await self._post(
            f"/internal/calls/{call_id}/events",
            {"orgId": org_id, "events": events},
            what="write transcript events",
        )

    async def finalize_call(
        self, call_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._post(
            f"/internal/calls/{call_id}/finalize", payload, what="finalize a call"
        )

    async def _post(
        self, path: str, payload: dict[str, Any], *, what: str
    ) -> dict[str, Any] | None:
        """Write to the control plane, logging rather than raising on failure.

        A call that is already connected must not be dropped because a record
        could not be written. Every one of these is idempotent, so a later
        retry -- the shutdown flush, or a redelivered webhook -- can still land
        what this one lost.
        """
        session = self._require_session()
        try:
            async with session.post(
                f"{self._base_url}{path}",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS),
            ) as response:
                if response.status < 300:
                    return await response.json()
                logger.warning(
                    "could not %s: %s returned %s (%s)",
                    what,
                    path,
                    response.status,
                    await _error_detail(response),
                )
        except Exception as exc:
            logger.warning("could not %s: %s", what, exc)
        return None


def _resolved(body: dict[str, Any]) -> ResolvedAgent:
    return ResolvedAgent(
        org_id=body["orgId"],
        agent_id=body["agentId"],
        agent_version_id=body["agentVersionId"],
        agent_slug=body["agentSlug"],
        prompt_mode=body["promptMode"],
        instructions=body["instructions"],
        greeting=body["greeting"],
        config=body.get("config") or {},
        record_calls=bool(body.get("recordCalls")),
    )


async def _error_detail(response: aiohttp.ClientResponse) -> str:
    try:
        body = await response.json()
        return str(body.get("error") or body)
    except Exception:
        return (await response.text())[:200]
