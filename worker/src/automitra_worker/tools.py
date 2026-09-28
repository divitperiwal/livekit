"""Customer tools: HTTP endpoints an agent can call mid-conversation.

A tool is a row in the control plane, not code. Its JSON Schema goes to the
model as a function definition; when the model calls it, the arguments are
sent to the customer's URL and whatever comes back is handed to the model to
speak from. Adding a tool is a dashboard action, not a deploy.

Every request goes through :mod:`ssrf`, because the URL is customer-supplied
and the worker makes the request from inside the platform's network. The name
is resolved and checked once, and the connection is made to the address that
was checked -- the pinned resolver below is what stops DNS from answering
differently between the check and the connect.

A caller hears silence while a tool runs. That shapes the rest of this module:
the timeout is the tool's own and short, a slow request gets a spoken "one
moment", and a large response is cut down before it reaches the model rather
than filling its context on every remaining turn of the call.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import socket
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import aiohttp
from aiohttp.abc import AbstractResolver, ResolveResult
from livekit.agents import RunContext, function_tool
from livekit.agents.llm import RawFunctionTool, ToolError

from .ssrf import SafeTarget, SSRFBlocked, resolve_safely
from .variables import render

logger = logging.getLogger("automitra.tools")

# Names the worker defines itself. A customer tool with one of these names
# would shadow the built-in, and the model would be calling something other
# than what the prompt describes. The control plane refuses them on save; this
# is the second check, for rows written before that rule existed.
RESERVED_NAMES = frozenset({"end_call", "transfer_call", "search_knowledge"})

# The most of a response body that is read at all. Past this the endpoint is
# returning something that was never meant for a phone call.
MAX_RESPONSE_BYTES = 64 * 1024

# What reaches the model. Every character here is re-read on every remaining
# turn of the call, and paid for each time.
MAX_OUTPUT_CHARS = 4_000

# How long a tool may run before the agent tells the caller it is still
# working on it. A tool marked slow is announced straight away.
ANNOUNCE_AFTER_SECONDS = 1.5

ANNOUNCE_INSTRUCTIONS = (
    "You are looking something up for the caller and it is taking a moment. "
    "Tell them so in one short sentence, in the language of the conversation. "
    "Do not guess at the answer."
)

# Headers the platform sets itself. A customer value for any of these would
# either be ignored or break the request.
_UNSETTABLE_HEADERS = frozenset(
    {"host", "content-length", "transfer-encoding", "connection", "authorization"}
)


@dataclass(frozen=True)
class ToolSpec:
    """One tool, as the control plane serves it."""

    name: str
    description: str
    parameters: dict[str, Any]
    url: str
    method: str = "POST"
    headers: dict[str, str] = field(default_factory=dict)
    auth_type: str = "none"
    # The header an `auth_type="header"` secret is sent in, e.g. X-API-Key.
    auth_header: str | None = None
    # Decrypted by the control plane and sent over the internal API. Never
    # logged, and never part of `repr`, so a stray log of the spec is safe.
    auth_secret: str | None = field(default=None, repr=False)
    timeout_ms: int = 5000
    response_template: str | None = None
    is_slow: bool = False

    @classmethod
    def from_json(cls, body: Mapping[str, Any]) -> ToolSpec | None:
        """Read one tool, or None if it is not usable.

        A malformed tool is dropped rather than failing the call: the agent can
        still hold a conversation without it, whereas refusing to answer would
        turn one bad row into an outage for that number.
        """
        try:
            name = str(body["name"])
            parameters = body.get("parametersSchema") or body.get("parameters") or {}
            if not isinstance(parameters, dict):
                raise ValueError("parametersSchema is not an object")
            parameters = dict(parameters)
            parameters.setdefault("type", "object")
            parameters.setdefault("properties", {})
            headers = body.get("headers") or {}
            return cls(
                name=name,
                description=str(body.get("description") or ""),
                parameters=parameters,
                url=str(body["url"]),
                method=str(body.get("method") or "POST").upper(),
                headers={str(k): str(v) for k, v in dict(headers).items()},
                auth_type=str(body.get("authType") or "none"),
                auth_header=body.get("authHeader") or None,
                auth_secret=body.get("authSecret") or None,
                timeout_ms=int(body.get("timeoutMs") or 5000),
                response_template=body.get("responseTemplate") or None,
                is_slow=bool(body.get("isSlow")),
            )
        except (KeyError, TypeError, ValueError) as exc:
            logger.error("dropping malformed tool %r: %s", body.get("name"), exc)
            return None


class ToolCallFailed(RuntimeError):
    """The tool could not produce an answer. The message is for the model."""


class _PinnedResolver(AbstractResolver):
    """Answers a DNS lookup with the one address that was already checked.

    Resolving the name again at connection time would reopen the rebinding
    hole :func:`ssrf.resolve_safely` exists to close. The hostname itself is
    still what goes in the TLS handshake, so certificate verification is
    unaffected.
    """

    def __init__(self, target: SafeTarget) -> None:
        self._target = target

    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[ResolveResult]:
        if host != self._target.host:
            # Only reachable through a redirect, which is not followed, or a
            # bug. Either way the answer is no.
            raise OSError(f"{host} is not the host that was checked")
        return [
            {
                "hostname": host,
                "host": self._target.ip,
                "port": port or self._target.port,
                "family": socket.AF_INET6 if self._target.is_ipv6 else socket.AF_INET,
                "proto": 0,
                "flags": socket.AI_NUMERICHOST,
            }
        ]

    async def close(self) -> None:
        return None


def sign(secret: str, timestamp: str, body: bytes) -> str:
    """The HMAC a receiving endpoint recomputes to trust a request.

    Over the timestamp as well as the body, so a captured request cannot be
    replayed later once the receiver rejects stale timestamps.
    """
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def _request_headers(
    spec: ToolSpec, body: bytes, *, call_id: str | None
) -> dict[str, str]:
    headers = {
        k: v for k, v in spec.headers.items() if k.lower() not in _UNSETTABLE_HEADERS
    }
    headers["User-Agent"] = "automitra-tools/1"
    if call_id:
        # Lets the customer tie a request back to the call in their own logs.
        headers["X-Automitra-Call-Id"] = call_id

    if spec.auth_type == "none":
        return headers
    if not spec.auth_secret:
        raise ToolCallFailed(
            "This tool is not set up correctly, so it could not be used. "
            "Apologise and offer to help another way."
        )
    if spec.auth_type == "bearer":
        headers["Authorization"] = f"Bearer {spec.auth_secret}"
    elif spec.auth_type == "header":
        headers[spec.auth_header or "X-API-Key"] = spec.auth_secret
    elif spec.auth_type == "hmac":
        timestamp = str(int(time.time()))
        headers["X-Automitra-Timestamp"] = timestamp
        headers["X-Automitra-Signature"] = sign(spec.auth_secret, timestamp, body)
    return headers


async def _read_capped(response: aiohttp.ClientResponse) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.content.iter_chunked(8192):
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            break
    return b"".join(chunks)[:MAX_RESPONSE_BYTES]


def shape(raw: bytes, template: str | None) -> str:
    """Turn a response body into what the model is given.

    With a template, only what it names reaches the model. Without one the body
    goes through as compact JSON, or as text, cut to a length the model can
    afford to keep re-reading.
    """
    text = raw.decode("utf-8", errors="replace").strip()
    try:
        data: Any = json.loads(text) if text else None
    except json.JSONDecodeError:
        data = None

    if template:
        return render(template, data if data is not None else {"body": text})[:MAX_OUTPUT_CHARS]

    if not text:
        return "The request succeeded."
    out = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if data is not None else text
    if len(out) > MAX_OUTPUT_CHARS:
        out = out[:MAX_OUTPUT_CHARS] + " [truncated]"
    return out


async def call_tool(
    spec: ToolSpec,
    arguments: Mapping[str, Any],
    *,
    call_id: str | None = None,
    resolver: Callable[[str], SafeTarget] = resolve_safely,
) -> str:
    """Make one tool request and return what the model should see.

    Raises :class:`ToolCallFailed` with a message written for the model, which
    it will turn into something to say. The detail of what went wrong is
    logged here instead, where an operator will look for it.
    """
    timeout = spec.timeout_ms / 1000.0
    try:
        return await asyncio.wait_for(
            _request(spec, arguments, call_id=call_id, resolver=resolver), timeout
        )
    except TimeoutError as exc:
        logger.warning("tool %s timed out after %.1fs", spec.name, timeout)
        raise ToolCallFailed(
            "That system did not answer in time. Apologise, and offer to "
            "follow up or help another way."
        ) from exc


async def _request(
    spec: ToolSpec,
    arguments: Mapping[str, Any],
    *,
    call_id: str | None,
    resolver: Callable[[str], SafeTarget],
) -> str:
    try:
        # getaddrinfo blocks, and this runs on the loop carrying audio.
        target = await asyncio.to_thread(resolver, spec.url)
    except SSRFBlocked as exc:
        logger.error("tool %s refused: %s", spec.name, exc)
        raise ToolCallFailed(
            "This tool is not available right now. Apologise and offer to "
            "help another way."
        ) from exc

    if spec.method == "GET":
        params = {k: v if isinstance(v, str) else json.dumps(v) for k, v in arguments.items()}
        body = b""
    else:
        params = None
        body = json.dumps(dict(arguments), ensure_ascii=False).encode()

    headers = _request_headers(spec, body, call_id=call_id)
    if body:
        headers["Content-Type"] = "application/json"

    connector = aiohttp.TCPConnector(resolver=_PinnedResolver(target), force_close=True)
    try:
        async with aiohttp.ClientSession(connector=connector) as http:
            async with http.request(
                spec.method,
                spec.url,
                params=params,
                data=body or None,
                headers=headers,
                # A permitted URL must not be able to hand off to a forbidden
                # one, so a redirect is an answer, not an instruction.
                allow_redirects=False,
            ) as response:
                raw = await _read_capped(response)
                status = response.status
    except aiohttp.ClientError as exc:
        logger.warning("tool %s request failed: %s", spec.name, exc)
        raise ToolCallFailed(
            "That system could not be reached. Apologise, and offer to follow "
            "up or help another way."
        ) from exc

    if status >= 300:
        logger.warning("tool %s returned %s: %s", spec.name, status, raw[:200])
        raise ToolCallFailed(
            f"That system returned an error ({status}). Do not read the error "
            "out; apologise and offer to help another way."
        )

    return shape(raw, spec.response_template)


def livekit_tool(
    spec: ToolSpec, *, call_id: Callable[[], str | None] = lambda: None
) -> RawFunctionTool:
    """Wrap a spec as a function tool the agent session can call.

    ``call_id`` is read at the moment of the call rather than captured now,
    because the call record is opened after the session starts.
    """

    async def handler(raw_arguments: dict[str, object], context: RunContext) -> str:
        delay = 0.0 if spec.is_slow else ANNOUNCE_AFTER_SECONDS
        announce = asyncio.create_task(_announce(context, delay))
        try:
            return await call_tool(spec, raw_arguments, call_id=call_id())
        except ToolCallFailed as exc:
            # A ToolError reaches the model as the tool's output, so the agent
            # can explain rather than going quiet.
            raise ToolError(str(exc)) from exc
        finally:
            announce.cancel()

    return function_tool(
        handler,
        raw_schema={
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.parameters,
        },
    )


async def _announce(context: RunContext, delay: float) -> None:
    """Tell the caller the agent is still working, if it is taking a while."""
    await asyncio.sleep(delay)
    try:
        context.session.generate_reply(
            instructions=ANNOUNCE_INSTRUCTIONS, tool_choice="none"
        )
    except Exception:
        logger.exception("could not announce a slow tool")


def customer_tools(
    specs: list[ToolSpec], *, call_id: Callable[[], str | None] = lambda: None
) -> list[RawFunctionTool]:
    """The tools to give the agent, minus any that would shadow a built-in."""
    out: list[RawFunctionTool] = []
    for spec in specs:
        if spec.name in RESERVED_NAMES:
            logger.error("ignoring tool %r: the name is reserved", spec.name)
            continue
        out.append(livekit_tool(spec, call_id=call_id))
    return out
