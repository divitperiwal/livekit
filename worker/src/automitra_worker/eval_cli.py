"""`uv run evals <run id>`: play a test run from the command line.

The dashboard dispatches test runs to the worker fleet; this runs the same
thing locally, against the control plane in CONTROL_PLANE_URL, which is the
quickest way to iterate on a prompt without a LiveKit project.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from dotenv import load_dotenv

from .control_plane import ControlPlane
from .evals import execute_run


async def _run(run_id: str) -> None:
    async with ControlPlane() as control_plane:
        await execute_run(control_plane, run_id)


def main() -> None:
    load_dotenv(".env.local")
    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) != 2:
        print("usage: evals <test run id>", file=sys.stderr)
        sys.exit(2)
    asyncio.run(_run(sys.argv[1]))
