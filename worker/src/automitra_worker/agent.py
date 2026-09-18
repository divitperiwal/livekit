"""A configurable WebRTC voice AI agent built on LiveKit Agents and Sarvam.

Speech, language and voice are all Sarvam models, reached through the native
``livekit-plugins-sarvam`` plugin rather than LiveKit Inference, so the stack
needs one ``SARVAM_API_KEY`` and bills in INR. LiveKit still provides the WebRTC
transport, the VAD and the semantic turn detector, which are model-agnostic.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    MetricsCollectedEvent,
    TurnHandlingOptions,
    inference,
    metrics,
    vad as vad_api,
)
from livekit.plugins import sarvam, silero

from . import transcript
from .budget import (
    RATE_INSTRUCTIONS,
    WARN_INSTRUCTIONS,
    CallBudget,
    RateGuard,
    Stage,
)
from .call_writer import CallWriter
from .config import AgentConfig
from .control_plane import ControlPlane
from .costs import actual_cost
from .resolve import CallIdentity, ResolutionFailed, resolve_call, sip_numbers
from .telephony import TelephonyConfig

logger = logging.getLogger("automitra.agent")


class VoiceAssistant(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


def load_vad(config: AgentConfig) -> vad_api.VAD:
    """Load the Silero VAD with the configured sensitivity."""
    return silero.VAD.load(
        min_speech_duration=config.vad_min_speech,
        min_silence_duration=config.vad_min_silence,
        prefix_padding_duration=config.vad_prefix_padding,
        activation_threshold=config.vad_activation_threshold,
    )


def prewarm(proc: JobProcess) -> None:
    """Load the VAD once per worker process.

    Without this the model would be loaded on the first frame of audio,
    delaying the start of the very first conversation.
    """
    config = AgentConfig.from_env()
    proc.userdata["vad"] = load_vad(config)
    logger.info("prewarmed VAD (min_silence=%.2fs)", config.vad_min_silence)


def build_session(
    config: AgentConfig, vad: vad_api.VAD | None = None
) -> AgentSession:
    """Assemble an AgentSession from configuration.

    Turn taking is two layered signals. The VAD decides when audio contains
    speech at all; the semantic turn detector then reads the words and prosody
    in the trailing silence to judge whether the thought is actually finished,
    so a mid-sentence pause does not get treated as the end of a turn. Both run
    independently of Sarvam -- the detector uses its own model.
    """
    llm_kwargs: dict[str, object] = {}
    if config.llm_temperature is not None:
        llm_kwargs["temperature"] = config.llm_temperature
    # Capping reply length caps TTS, which is two thirds of the bill. This
    # bounds the cost of any single turn rather than the call as a whole.
    if config.max_response_tokens is not None:
        llm_kwargs["max_tokens"] = config.max_response_tokens

    turn_handling: TurnHandlingOptions = {
        "endpointing": {
            # Dynamic endpointing adapts the wait to how confident the
            # detector is, between these bounds.
            "mode": "dynamic",
            "min_delay": config.endpointing_min_delay,
            "max_delay": config.endpointing_max_delay,
        }
    }
    turn_handling["turn_detection"] = (
        inference.TurnDetector() if config.use_turn_detector else "vad"
    )

    return AgentSession(
        stt=sarvam.STT(
            model=config.stt_model,
            mode=config.stt_mode,
            language=config.stt_language,
        ),
        llm=sarvam.LLM(model=config.llm_model, **llm_kwargs),
        tts=sarvam.TTS(
            model=config.tts_model,
            speaker=config.tts_speaker,
            target_language_code=config.tts_language,
            pace=config.tts_pace,
        ),
        vad=vad if vad is not None else load_vad(config),
        turn_handling=turn_handling,
    )


async def entrypoint(ctx: JobContext) -> None:
    telephony = TelephonyConfig.from_env()

    async with ControlPlane() as control_plane:
        if control_plane.configured:
            # The multi-tenant path. Resolution happens before ctx.connect(),
            # so the work overlaps with WebRTC and SIP media setup rather than
            # adding to the silence before the agent speaks.
            try:
                identity = await resolve_call(ctx, control_plane)
            except ResolutionFailed as exc:
                # Nothing safe to fall back to: answering with whatever
                # configuration is at hand would put this caller through to
                # another company's script. End the call instead, loudly.
                logger.error("refusing the call: %s", exc)
                ctx.shutdown(reason="agent could not be resolved")
                return
            config = identity.config
        else:
            # No control plane configured: local development, `agent console`,
            # or a deployment still running on environment variables.
            logger.info("no control plane configured; using environment config")
            identity = None
            config = AgentConfig.from_env()

        await _run_call(ctx, config, telephony, identity, control_plane)


async def _run_call(
    ctx: JobContext,
    config: AgentConfig,
    telephony: TelephonyConfig,
    identity: CallIdentity | None,
    control_plane: ControlPlane,
) -> None:
    logger.info("starting voice agent: %s", config.describe())

    session = build_session(config, vad=ctx.proc.userdata.get("vad"))
    assistant = VoiceAssistant(config.instructions)

    # Tally real usage so the call can be costed from measured numbers rather
    # than an assumed conversation shape.
    usage = metrics.UsageCollector()

    budget = CallBudget(
        limit_inr=config.budget_inr,
        stt_model=config.stt_model,
        tts_model=config.tts_model,
        llm_model=config.llm_model,
        warn_at=config.budget_warn_at,
        wrap_at=config.budget_wrap_at,
    )
    budget.validate()

    rate_guard = RateGuard(
        ceiling_inr_per_min=config.max_inr_per_min,
        stt_model=config.stt_model,
        tts_model=config.tts_model,
        llm_model=config.llm_model,
    )
    rate_guard.validate()
    started_at = time.monotonic()
    if rate_guard.enabled:
        logger.info(
            "rate ceiling: Rs %.2f/min (Rs %.2f/min of that is speech-to-text, "
            "which is fixed)",
            rate_guard.ceiling_inr_per_min,
            rate_guard.floor_inr_per_min,
        )

    if budget.enabled:
        logger.info(
            "call budget: Rs %.2f (>= %.1f min even if the agent never stops "
            "talking; longer in a normal two-sided conversation)",
            budget.limit_inr,
            budget.implied_minutes(),
        )

    # Guards the close sequence: metrics events keep arriving while the
    # farewell is being spoken, and the call must only be ended once.
    closing = asyncio.Event()

    # Set once the call record exists. Until then there is nowhere to write
    # events, so they are recorded against nothing and dropped -- which only
    # covers the moments before the far end has even joined.
    writer: CallWriter | None = None

    # Why the session ended, as the SDK reports it. Captured rather than
    # inferred: the budget stage is OK on any normal call, so using it would
    # label every ordinary hang-up "ok" and say nothing about what happened.
    ended_because: dict[str, str] = {}

    def record(row: dict[str, object] | None) -> None:
        """Buffer one event row, if there is a call to attach it to.

        Synchronous on purpose: this is called from session event handlers,
        which run on the loop carrying audio.
        """
        if writer is not None and row is not None:
            writer.add(
                str(row["type"]),
                role=row.get("role"),  # type: ignore[arg-type]
                content=row.get("content"),  # type: ignore[arg-type]
                payload=row.get("payload"),  # type: ignore[arg-type]
            )

    async def end_call(*, graceful: bool) -> None:
        """Wind the call up, then close the session."""
        if graceful:
            try:
                # Wait for the farewell to actually reach the user; closing
                # mid-sentence is what the wrap stage exists to avoid.
                await session.say(config.budget_farewell, allow_interruptions=False)
            except Exception:
                logger.exception("budget farewell failed; closing anyway")
        logger.info(
            "ending call on budget: Rs %.3f of Rs %.2f",
            budget.spent_inr,
            budget.limit_inr,
        )
        await session.aclose()

    @session.on("conversation_item_added")
    def _on_item(ev: Any) -> None:
        """One finished turn.

        This event rather than ``user_input_transcribed``, which fires
        repeatedly as speech is recognised and would write the same sentence
        several times over in progressively more complete forms.
        """
        record(transcript.conversation_item(ev.item))

    @session.on("function_tools_executed")
    def _on_tools(ev: Any) -> None:
        for row in transcript.tool_events(
            list(getattr(ev, "function_calls", []) or []),
            list(getattr(ev, "function_call_outputs", []) or []),
        ):
            record(row)

    @session.on("close")
    def _on_close(ev: Any) -> None:
        ended_because["reason"] = transcript.close_reason(ev)

    @session.on("error")
    def _on_error(ev: Any) -> None:
        # A transcript that simply stops is hard to account for later; the
        # reason is usually whichever component failed.
        record(transcript.error_event(getattr(ev, "error", None), getattr(ev, "source", None)))

    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent) -> None:
        metrics.log_metrics(ev.metrics)
        usage.collect(ev.metrics)

        if closing.is_set():
            return

        # The rate guard is independent of the per-call budget: it bounds
        # cost per minute rather than cost per call.
        if rate_guard.update(usage.get_summary(), time.monotonic() - started_at):
            asyncio.create_task(
                assistant.update_instructions(
                    config.instructions + RATE_INSTRUCTIONS
                )
            )

        if not budget.enabled:
            return

        previous = budget.stage
        stage = budget.update(usage.get_summary())
        if stage == previous:
            return

        # Recorded so a call that ends politely but early is explicable
        # afterwards, rather than looking like the agent hung up unprompted.
        record(transcript.stage_event(stage.name, budget.spent_inr, budget.limit_inr))

        if stage is Stage.WARN:
            # Steer the agent without interrupting it: the new instructions
            # apply from its next reply onward.
            asyncio.create_task(
                assistant.update_instructions(
                    config.instructions + WARN_INSTRUCTIONS
                )
            )
        elif stage is Stage.WRAP:
            closing.set()
            asyncio.create_task(end_call(graceful=True))
        elif stage is Stage.HARD:
            closing.set()
            asyncio.create_task(end_call(graceful=False))

    # The call record's id, once the control plane has opened one. None when
    # running on environment config, or when the record could not be written.
    call_id: str | None = None

    async def report_usage() -> None:
        summary = usage.get_summary()
        logger.info(
            "usage: stt=%.1fs tts=%d chars llm=%d/%d tokens",
            summary.stt_audio_duration,
            summary.tts_characters_count,
            summary.llm_prompt_tokens,
            summary.llm_completion_tokens,
        )

        cost = None
        try:
            cost = actual_cost(
                summary,
                stt_model=config.stt_model,
                tts_model=config.tts_model,
                llm_model=config.llm_model,
            )
        except KeyError as exc:
            # An unpriced model must not lose the usage record: the row is
            # written flagged for review and can be repriced, whereas a
            # discarded one is revenue that silently never existed.
            logger.info("cost unavailable: %s", exc.args[0])

        if cost is not None:
            minutes = summary.stt_audio_duration / 60.0
            per_min = cost.total_inr / minutes if minutes else 0.0
            logger.info(
                "session cost: Rs %.4f total (~Rs %.3f/min) [estimate, list prices]",
                cost.total_inr,
                per_min,
            )

        if call_id is None or identity is None:
            return

        # Drain the buffer before finalizing, so the call is not marked
        # complete while the last of its transcript is still in memory.
        if writer is not None:
            await writer.aclose()

        elapsed = int(time.monotonic() - started_at)
        await control_plane.finalize_call(
            call_id,
            {
                "status": "completed",
                # The budget stage wins when it ended the call, since "the
                # ceiling was reached" is more useful than "the session
                # closed"; otherwise whatever the SDK reported.
                "endReason": (
                    budget.stage.name.lower()
                    if budget.stage is not Stage.OK
                    else ended_because.get("reason")
                ),
                "durationSeconds": elapsed,
                "billableSeconds": elapsed,
                "usage": {
                    "sttSeconds": summary.stt_audio_duration,
                    "ttsCharacters": summary.tts_characters_count,
                    "llmPromptTokens": summary.llm_prompt_tokens,
                    "llmCachedTokens": getattr(
                        summary, "llm_prompt_cached_tokens", 0
                    ),
                    "llmCompletionTokens": summary.llm_completion_tokens,
                    "costInr": cost.total_inr if cost else None,
                    "needsReview": cost is None,
                    "reviewReason": None if cost else "model has no rate card entry",
                },
            },
        )

    ctx.add_shutdown_callback(report_usage)

    await session.start(agent=assistant, room=ctx.room)

    # On a phone call the agent is often in the room before the far end is:
    # inbound audio is still being negotiated, and an outbound call has not
    # been answered yet. Greeting into that gap means the caller misses the
    # opening line entirely, so wait for the phone leg to actually appear.
    caller_number = identity.caller_number if identity else None
    dialled_number = identity.dialled_number if identity else None
    if telephony.enabled:
        try:
            participant = await ctx.wait_for_participant()
            caller, dialled = sip_numbers(participant)
            caller_number = caller or caller_number
            dialled_number = dialled or dialled_number
            logger.info(
                "phone call connected: %s (%s)",
                caller_number or "unknown number",
                participant.identity,
            )
        except Exception:
            logger.exception("no participant joined; greeting anyway")

    # Opened after the far end is known, so the record carries both numbers
    # from the outset rather than being patched afterwards.
    if identity is not None:
        opened = await control_plane.start_call(
            {
                "orgId": identity.agent.org_id,
                "agentId": identity.agent.agent_id,
                "agentVersionId": identity.agent.agent_version_id,
                "lkRoomName": ctx.room.name,
                "lkJobId": ctx.job.id,
                "direction": identity.direction,
                "fromNumber": caller_number,
                "toNumber": dialled_number,
                "phoneNumberId": identity.meta.phone_number_id,
            }
        )
        if opened:
            call_id = opened["id"]
            writer = CallWriter(
                control_plane=control_plane,
                call_id=call_id,
                org_id=identity.agent.org_id,
            )
            writer.start()
            logger.info("call record %s", call_id)

    await session.generate_reply(instructions=config.greeting)


def build_server() -> AgentServer:
    """Construct and register the worker.

    Deliberately a function rather than module-level code. Importing this
    module must not start a worker, read the environment or touch the network:
    the tests import it, and so will anything that wants ``build_session`` or
    ``entrypoint`` without running them.

    The agent name is a routing label for the worker pool, not a tenant
    identity -- it is what a SIP dispatch rule targets and what an outbound
    call dispatches into a room. One name serves every tenant; which tenant a
    call belongs to arrives per job, in its metadata.
    """
    server = AgentServer(setup_fnc=prewarm)
    agent_name = TelephonyConfig.from_env().agent_name or ""
    server.rtc_session(agent_name=agent_name)(entrypoint)
    return server


def main() -> None:
    # Loaded here rather than at import: a module that reads .env on import
    # cannot be imported by anything that does not want its side effects.
    load_dotenv(".env.local")
    load_dotenv()
    agents.cli.run_app(build_server())


if __name__ == "__main__":
    main()
