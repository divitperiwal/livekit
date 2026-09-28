"""Calling a customer's HTTP tool.

These run against a real local HTTP server, with the SSRF resolver swapped for
one that permits loopback -- the one thing the production resolver exists to
refuse. Everything else is the production path: the pinned connection, the
headers, the redirect policy, the response shaping.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from urllib.parse import urlsplit

import pytest
from aiohttp import web

from automitra_worker.ssrf import SafeTarget
from automitra_worker.tools import (
    MAX_OUTPUT_CHARS,
    ToolCallFailed,
    ToolSpec,
    call_tool,
    customer_tools,
    shape,
    sign,
)


def loopback(url: str) -> SafeTarget:
    """A resolver that allows 127.0.0.1, for tests only."""
    parts = urlsplit(url)
    return SafeTarget(url=url, host=parts.hostname or "", port=parts.port or 80, ip="127.0.0.1")


def spec(url: str, **overrides: object) -> ToolSpec:
    fields: dict[str, object] = {
        "name": "lookup_order",
        "description": "Look up an order",
        "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}},
        "url": url,
    }
    fields.update(overrides)
    return ToolSpec(**fields)  # type: ignore[arg-type]


@pytest.fixture
async def server() -> AsyncIterator[tuple[str, list[web.Request], list[bytes]]]:
    """A local server recording every request it receives."""
    seen: list[web.Request] = []
    bodies: list[bytes] = []

    async def echo(request: web.Request) -> web.Response:
        seen.append(request)
        bodies.append(await request.read())
        return web.json_response(
            {"status": "shipped", "eta": "Friday", "query": dict(request.query)}
        )

    async def redirect(request: web.Request) -> web.Response:
        seen.append(request)
        raise web.HTTPFound("http://169.254.169.254/latest/meta-data")

    async def broken(request: web.Request) -> web.Response:
        seen.append(request)
        return web.Response(status=500, text="database exploded: password=hunter2")

    async def slow(request: web.Request) -> web.Response:
        await asyncio.sleep(2)
        return web.json_response({})

    async def huge(request: web.Request) -> web.Response:
        return web.Response(text="y" * 200_000)

    app = web.Application()
    app.router.add_route("*", "/echo", echo)
    app.router.add_route("*", "/redirect", redirect)
    app.router.add_route("*", "/broken", broken)
    app.router.add_route("*", "/slow", slow)
    app.router.add_route("*", "/huge", huge)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    try:
        yield f"http://tools.test:{port}", seen, bodies
    finally:
        await runner.cleanup()


async def test_post_sends_the_arguments_as_json(server) -> None:
    base, seen, bodies = server
    out = await call_tool(spec(f"{base}/echo"), {"order_id": "A12"}, call_id="c-1", resolver=loopback)

    assert json.loads(bodies[0]) == {"order_id": "A12"}
    assert seen[0].method == "POST"
    assert seen[0].headers["X-Automitra-Call-Id"] == "c-1"
    # The hostname, not the pinned address, is what the request names.
    assert seen[0].headers["Host"].startswith("tools.test")
    assert json.loads(out)["status"] == "shipped"


async def test_get_sends_the_arguments_as_query(server) -> None:
    base, seen, _ = server
    out = await call_tool(spec(f"{base}/echo", method="GET"), {"order_id": "A12"}, resolver=loopback)
    assert seen[0].query["order_id"] == "A12"
    assert json.loads(out)["query"] == {"order_id": "A12"}


async def test_a_template_decides_what_the_model_sees(server) -> None:
    base, _, _ = server
    out = await call_tool(
        spec(f"{base}/echo", response_template="Order is {{status}}, arriving {{eta}}."),
        {},
        resolver=loopback,
    )
    assert out == "Order is shipped, arriving Friday."


async def test_bearer_auth(server) -> None:
    base, seen, _ = server
    await call_tool(spec(f"{base}/echo", auth_type="bearer", auth_secret="s3cret"), {}, resolver=loopback)
    assert seen[0].headers["Authorization"] == "Bearer s3cret"


async def test_header_auth(server) -> None:
    base, seen, _ = server
    await call_tool(
        spec(f"{base}/echo", auth_type="header", auth_header="X-Api-Key", auth_secret="k"),
        {},
        resolver=loopback,
    )
    assert seen[0].headers["X-Api-Key"] == "k"


async def test_hmac_signs_the_exact_body(server) -> None:
    base, seen, bodies = server
    await call_tool(spec(f"{base}/echo", auth_type="hmac", auth_secret="shh"), {"a": 1}, resolver=loopback)
    headers = seen[0].headers
    expected = sign("shh", headers["X-Automitra-Timestamp"], bodies[0])
    assert headers["X-Automitra-Signature"] == expected


async def test_a_customer_header_cannot_smuggle_authorization(server) -> None:
    """Secrets belong behind auth_type, where they are encrypted at rest."""
    base, seen, _ = server
    await call_tool(
        spec(f"{base}/echo", headers={"Authorization": "Bearer plain", "X-Tenant": "kbs"}),
        {},
        resolver=loopback,
    )
    assert "Authorization" not in seen[0].headers
    assert seen[0].headers["X-Tenant"] == "kbs"


async def test_auth_without_a_secret_fails_without_calling(server) -> None:
    base, seen, _ = server
    with pytest.raises(ToolCallFailed):
        await call_tool(spec(f"{base}/echo", auth_type="bearer"), {}, resolver=loopback)
    assert seen == []


async def test_a_redirect_is_not_followed(server) -> None:
    """A permitted URL must not hand off to the metadata service."""
    base, seen, _ = server
    with pytest.raises(ToolCallFailed):
        await call_tool(spec(f"{base}/redirect"), {}, resolver=loopback)
    assert len(seen) == 1


async def test_an_error_status_does_not_reach_the_model_verbatim(server) -> None:
    base, _, _ = server
    with pytest.raises(ToolCallFailed) as raised:
        await call_tool(spec(f"{base}/broken"), {}, resolver=loopback)
    assert "hunter2" not in str(raised.value)


async def test_the_tool_timeout_is_enforced(server) -> None:
    base, _, _ = server
    with pytest.raises(ToolCallFailed, match="in time"):
        await call_tool(spec(f"{base}/slow", timeout_ms=200), {}, resolver=loopback)


async def test_a_huge_response_is_cut_down(server) -> None:
    base, _, _ = server
    out = await call_tool(spec(f"{base}/huge"), {}, resolver=loopback)
    assert len(out) <= MAX_OUTPUT_CHARS + len(" [truncated]")


async def test_the_production_resolver_refuses_loopback() -> None:
    """No resolver override: the SSRF guard is what answers."""
    with pytest.raises(ToolCallFailed):
        await call_tool(spec("https://127.0.0.1/echo"), {})


def test_shape_without_a_template() -> None:
    assert shape(b"", None) == "The request succeeded."
    assert shape(b'{"a": 1,  "b": [1, 2]}', None) == '{"a":1,"b":[1,2]}'
    assert shape(b"plain text", None) == "plain text"


def test_shape_with_a_template_over_text() -> None:
    assert shape(b"not json", "Got: {{body}}") == "Got: not json"


def test_from_json_reads_the_control_plane_shape() -> None:
    parsed = ToolSpec.from_json(
        {
            "name": "book",
            "description": "Book a slot",
            "parametersSchema": {"properties": {"slot": {"type": "string"}}},
            "url": "https://crm.example.com/book",
            "method": "post",
            "authType": "bearer",
            "authSecret": "s",
            "timeoutMs": 3000,
            "isSlow": True,
        }
    )
    assert parsed is not None
    assert parsed.method == "POST"
    assert parsed.parameters["type"] == "object"
    assert parsed.timeout_ms == 3000
    assert parsed.is_slow
    # A secret must never reach a log line through repr.
    assert "'s'" not in repr(parsed)


def test_from_json_drops_a_malformed_tool() -> None:
    assert ToolSpec.from_json({"description": "no name or url"}) is None
    assert ToolSpec.from_json({"name": "x", "url": "https://a.b", "parametersSchema": [1]}) is None


def test_a_tool_cannot_shadow_a_built_in() -> None:
    specs = [spec("https://a.example", name="end_call"), spec("https://a.example", name="lookup")]
    tools = customer_tools(specs)
    assert [t.info.name for t in tools] == ["lookup"]


def test_a_tool_is_offered_to_the_model_with_its_own_schema() -> None:
    tools: list = customer_tools([spec("https://a.example")])
    schema: Callable = lambda t: t.info.raw_schema  # noqa: E731
    assert schema(tools[0])["name"] == "lookup_order"
    assert schema(tools[0])["parameters"]["properties"]["order_id"]["type"] == "string"
