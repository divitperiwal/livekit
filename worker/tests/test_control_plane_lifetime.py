"""The control-plane client has to outlive the entrypoint.

A call's last writes -- the transcript flush and the usage record -- happen in
a shutdown callback, which runs *after* the entrypoint has returned. A client
scoped to a `with` block inside that entrypoint is already closed by then, so
every one of those writes fails: the call sits at `in_progress` for ever, is
never billed, and its transcript is lost.

That failure is invisible to a test that uses the client inside a `with` block,
which is why it survived until a real call was made. These tests use it the way
the entrypoint does.
"""

from __future__ import annotations

import pytest

from automitra_worker.control_plane import ControlPlane, ControlPlaneError


async def test_a_client_can_be_opened_without_a_with_block() -> None:
    plane = await ControlPlane(base_url="http://localhost:1", secret="x").open()
    try:
        assert plane.configured
    finally:
        await plane.aclose()


async def test_the_client_still_works_after_the_scope_that_made_it_returns() -> None:
    """The shape the entrypoint relies on.

    Something opens the client and returns; a callback registered by it writes
    later. If closing were tied to that scope, this write would raise
    "use ControlPlane as an async context manager" -- which is exactly what a
    real call did.
    """
    holder: dict[str, ControlPlane] = {}

    async def entrypoint_like() -> None:
        holder["plane"] = await ControlPlane(
            base_url="http://localhost:1", secret="x"
        ).open()
        # Returns without closing, exactly as the entrypoint does.

    await entrypoint_like()
    plane = holder["plane"]

    try:
        # Unreachable host, so this fails -- but it must fail as a *network*
        # problem, logged and swallowed, not by raising about a missing
        # session. The distinction is the bug.
        result = await plane.start_call({"lkJobId": "JOB_x"})
        assert result is None
    finally:
        await plane.aclose()


async def test_using_a_closed_client_raises_rather_than_failing_silently() -> None:
    plane = ControlPlane(base_url="http://localhost:1", secret="x")
    with pytest.raises(ControlPlaneError, match="context manager"):
        await plane.resolve(agent_id="a")


async def test_closing_twice_is_safe() -> None:
    """The shutdown path may run more than once."""
    plane = await ControlPlane(base_url="http://localhost:1", secret="x").open()
    await plane.aclose()
    await plane.aclose()


async def test_the_context_manager_still_works() -> None:
    """`with` remains valid for callers whose writes finish inside the block."""
    async with ControlPlane(base_url="http://localhost:1", secret="x") as plane:
        assert plane.configured
