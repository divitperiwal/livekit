"""The worker process: prewarm, the per-call entrypoint, and the LiveKit agent server.

    uv run agent console          # talk to the agent in the terminal, no LiveKit server
    uv run agent dev              # connect to LIVEKIT_URL, reload on change
    uv run agent start            # production
    uv run agent download-files   # fetch model weights (run at image build time)

With INTERNAL_API_SECRET set the worker is multi-tenant: every call is resolved through
the API. Unset, it is single-tenant dev mode, running the agent from environment
variables and reporting nothing.
"""

import asyncio
import logging
import os
import sys

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import AgentServer, JobContext, JobExecutorType, JobProcess

from automitra_worker.agent_config.environment import agent_from_environment
from automitra_worker.agent_config.model import AgentConfigModel
from automitra_worker.call import run_call, run_post_call_step
from automitra_worker.control_plane.client import ControlPlaneClient
from automitra_worker.control_plane.resolution import (
    JobMetadata,
    OutOfCreditRefusal,
    ResolutionFailed,
    resolve_call,
)
from automitra_worker.pipeline.session import load_vad
from automitra_worker.telephony.settings import TelephonySettings

logger = logging.getLogger("automitra.worker")

DEFAULT_CONTROL_PLANE_URL = "http://localhost:3000"
# Each idle process holds ~280 MB (VAD + turn detector) before a call arrives. LiveKit's
# production default of 12 would idle at ~3.4 GB per worker container.
DEFAULT_IDLE_PROCESSES = 2
PHONE_PARTICIPANT_WAIT_SECONDS = 10.0


def prewarm(process: JobProcess) -> None:
    """Load the VAD once per process, so the first call does not wait for it."""
    process.userdata["vad"] = load_vad(AgentConfigModel())


async def entrypoint(ctx: JobContext) -> None:
    telephony = TelephonySettings.from_environment()
    metadata = JobMetadata.parse(ctx.job.metadata)
    secret = os.getenv("INTERNAL_API_SECRET", "").strip()
    if not secret:
        logger.info("no INTERNAL_API_SECRET: single-tenant dev mode, agent from the environment")
        runtime_agent = agent_from_environment().with_variables(metadata.variables or {})
        await run_call(ctx, runtime_agent, metadata=metadata, telephony=telephony)
        return

    # Closed by run_call's last write, which runs after this function returns.
    client = await ControlPlaneClient(
        os.getenv("CONTROL_PLANE_URL", DEFAULT_CONTROL_PLANE_URL), secret
    ).open()
    try:
        try:
            # Before the session joins the room, so it overlaps LiveKit's media setup.
            resolved = await resolve_call(metadata, client, lambda: _phone_participant(ctx))
        except OutOfCreditRefusal as refusal:
            logger.warning("declining the call, out of credit: %s", refusal)
            ctx.shutdown(reason="out of credit")
            await client.aclose()
            return
        except ResolutionFailed as failure:
            # Never answered with a fallback: that would be another company's script.
            logger.error("refusing the call: %s", failure)
            ctx.shutdown(reason="agent could not be resolved")
            await client.aclose()
            return
        runtime_agent = resolved.runtime_agent.with_variables(metadata.variables or {})
        await run_call(
            ctx,
            runtime_agent,
            metadata=metadata,
            telephony=telephony,
            resolved=resolved,
            client=client,
        )
    except Exception:
        await client.aclose()
        raise


async def _phone_participant(ctx: JobContext) -> rtc.RemoteParticipant | None:
    """The phone leg, so its dialled number can be read. Only on the fallback path."""
    try:
        await ctx.connect()
        return await asyncio.wait_for(
            ctx.wait_for_participant(kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP),
            PHONE_PARTICIPANT_WAIT_SECONDS,
        )
    except Exception:
        logger.exception("no phone participant joined")
        return None


def build_server() -> AgentServer:
    """A function, not module-level code: importing this module must not read the
    environment or start anything.

    Each call runs in its own process: a crash ends one call, not every call on the
    worker, and per-call VAD settings cannot leak into another call.

    The agent name routes jobs to this worker fleet; it is not a tenant identity.
    """
    # Read now so a misconfigured telephony setup stops the worker at start, not every call.
    telephony = TelephonySettings.from_environment()
    for warning in telephony.warnings:
        logger.warning(warning)
    server = AgentServer(
        setup_fnc=prewarm,
        job_executor_type=JobExecutorType.PROCESS,
        num_idle_processes=int(os.getenv("WORKER_IDLE_PROCESSES", DEFAULT_IDLE_PROCESSES)),
    )
    server.rtc_session(agent_name=telephony.agent_name or "", on_session_end=run_post_call_step)(
        entrypoint
    )
    return server


def main() -> None:
    load_dotenv(".env.local")
    load_dotenv()
    _write_utf8_even_when_redirected()
    agents.cli.run_app(build_server())


def _write_utf8_even_when_redirected() -> None:
    """Redirected on Windows, Python falls back to the ANSI code page, and LiveKit's first
    console line (an emoji) or any Hindi transcript raises UnicodeEncodeError."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None and (stream.encoding or "").lower() != "utf-8":
            reconfigure(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    main()
