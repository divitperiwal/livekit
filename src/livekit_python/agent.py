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

from .budget import (
    RATE_INSTRUCTIONS,
    WARN_INSTRUCTIONS,
    CallBudget,
    RateGuard,
    Stage,
)
from .config import AgentConfig
from .costs import actual_cost
from .telephony import TelephonyConfig

load_dotenv(".env.local")
load_dotenv()

logger = logging.getLogger("livekit-python.agent")


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


server = AgentServer(setup_fnc=prewarm)

# A named worker is what a SIP dispatch rule can target explicitly, and what an
# outbound call dispatches into its room. Left unset the worker takes automatic
# jobs instead, which is right for WebRTC-only use and ambiguous the moment two
# agents share a LiveKit project.
_telephony = TelephonyConfig.from_env()


@server.rtc_session(agent_name=_telephony.agent_name or "")
async def entrypoint(ctx: JobContext) -> None:
    config = AgentConfig.from_env()
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

    async def report_usage() -> None:
        summary = usage.get_summary()
        logger.info(
            "usage: stt=%.1fs tts=%d chars llm=%d/%d tokens",
            summary.stt_audio_duration,
            summary.tts_characters_count,
            summary.llm_prompt_tokens,
            summary.llm_completion_tokens,
        )
        try:
            cost = actual_cost(
                summary,
                stt_model=config.stt_model,
                tts_model=config.tts_model,
                llm_model=config.llm_model,
            )
        except KeyError as exc:
            logger.info("cost unavailable: %s", exc.args[0])
            return
        minutes = summary.stt_audio_duration / 60.0
        per_min = cost.total_inr / minutes if minutes else 0.0
        logger.info(
            "session cost: Rs %.4f total (~Rs %.3f/min) [estimate, list prices]",
            cost.total_inr,
            per_min,
        )

    ctx.add_shutdown_callback(report_usage)

    await session.start(agent=assistant, room=ctx.room)

    # On a phone call the agent is often in the room before the far end is:
    # inbound audio is still being negotiated, and an outbound call has not
    # been answered yet. Greeting into that gap means the caller misses the
    # opening line entirely, so wait for the phone leg to actually appear.
    if _telephony.enabled:
        try:
            participant = await ctx.wait_for_participant()
            number = participant.attributes.get("sip.phoneNumber")
            logger.info(
                "phone call connected: %s (%s)",
                number or "unknown number",
                participant.identity,
            )
        except Exception:
            logger.exception("no participant joined; greeting anyway")

    await session.generate_reply(instructions=config.greeting)


def main() -> None:
    agents.cli.run_app(server)


if __name__ == "__main__":
    main()
