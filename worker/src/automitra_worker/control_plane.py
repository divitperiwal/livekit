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

from .tools import ToolSpec

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


class OutOfCredit(AgentNotResolved):
    """The organisation cannot pay for this call.

    A refusal rather than a failure, and worth distinguishing: it is the one
    reason a call is declined that the customer can do something about.
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
    # What is left to spend, so the call's own budget can be capped to it.
    # None when the control plane did not say.
    available_inr: float | None = None
    # The customer tools attached to this version, secrets included.
    tools: tuple[ToolSpec, ...] = ()
    # Whether the version has knowledge bases to search.
    has_knowledge: bool = False

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

    async def open(self) -> ControlPlane:
        """Start the session without tying it to a `with` block.

        A call's last writes happen in a shutdown callback, after the
        entrypoint has already returned, so the client has to outlive the
        scope that created it. Whoever opens it is responsible for `aclose`.
        """
        if self._session is None:
            self._session = aiohttp.ClientSession(
                headers={"x-internal-secret": self._secret}
            )
        return self

    async def aclose(self) -> None:
        """Close the session. Safe to call more than once."""
        if self._owned and self._session is not None:
            await self._session.close()
            self._session = None

    async def __aenter__(self) -> ControlPlane:
        return await self.open()

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

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
                if response.status == 402:
                    raise OutOfCredit(detail)
                if response.status in (403, 404, 409):
                    raise AgentNotResolved(detail)
                raise ControlPlaneError(f"resolve returned {response.status}: {detail}")
        except aiohttp.ClientError as exc:
            raise ControlPlaneError(f"could not reach the control plane: {exc}") from exc
        except TimeoutError as exc:
            raise ControlPlaneError(
                f"the control plane did not answer within {RESOLVE_TIMEOUT_SECONDS}s"
            ) from exc

    # --- knowledge ----------------------------------------------------------

    async def search_knowledge(self, agent_version_id: str, org_id: str, query: str) -> list[str]:
        """Passages from the version's knowledge bases that answer ``query``.

        On the path a caller is waiting through, so the timeout is the short
        one, and a failure raises for the tool to turn into "I am not sure".
        """
        session = self._require_session()
        async with session.get(
            f"{self._base_url}/internal/knowledge/search",
            params={"agentVersionId": agent_version_id, "orgId": org_id, "q": query},
            timeout=aiohttp.ClientTimeout(total=RESOLVE_TIMEOUT_SECONDS),
        ) as response:
            if response.status != 200:
                raise ControlPlaneError(
                    f"knowledge search returned {response.status}: {await _error_detail(response)}"
                )
            body = await response.json()
        return [str(p["content"]) for p in body.get("passages") or [] if isinstance(p, dict) and p.get("content")]

    # --- test runs ----------------------------------------------------------

    async def eval_run(self, run_id: str) -> dict[str, Any]:
        """A test run: its scenarios, and the agent version under test."""
        session = self._require_session()
        async with session.get(
            f"{self._base_url}/internal/eval-runs/{run_id}",
            timeout=aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS),
        ) as response:
            if response.status != 200:
                raise ControlPlaneError(f"eval run {run_id}: {response.status} {await _error_detail(response)}")
            return await response.json()

    async def eval_result(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        return await self._post(f"/internal/eval-runs/{run_id}/results", payload, what="record a test result")

    async def finish_eval_run(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        return await self._post(f"/internal/eval-runs/{run_id}/finish", payload, what="finish a test run")

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
    tools = tuple(
        spec
        for spec in (ToolSpec.from_json(t) for t in body.get("tools") or [] if isinstance(t, dict))
        if spec is not None
    )
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
        available_inr=(
            float(body["availableInr"]) if body.get("availableInr") is not None else None
        ),
        tools=tools,
        has_knowledge=bool(body.get("knowledgeBaseCount")),
    )


async def _error_detail(response: aiohttp.ClientResponse) -> str:
    try:
        body = await response.json()
        return str(body.get("error") or body)
    except Exception:
        return (await response.text())[:200]
