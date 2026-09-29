"""A configurable WebRTC voice AI agent built on LiveKit Agents and Sarvam.

Speech, language and voice are all Sarvam models, reached through the native
``livekit-plugins-sarvam`` plugin rather than LiveKit Inference, so the stack
needs one ``SARVAM_API_KEY`` and bills in INR. LiveKit still provides the WebRTC
transport, the VAD and the semantic turn detector, which are model-agnostic.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from contextlib import AsyncExitStack
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from typing import Any

from dotenv import load_dotenv
from livekit import agents, api, rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    FlushSentinel,
    MetricsCollectedEvent,
    ModelSettings,
    TurnHandlingOptions,
    inference,
    llm as llm_api,
    metrics,
    stt as stt_api,
    tts as tts_api,
    vad as vad_api,
)
from livekit.agents.beta.tools.send_dtmf import send_dtmf_events
from livekit.agents.voice.amd import AMD, AMDCategory
from livekit.plugins import sarvam, silero

from . import transcript
from .analysis import Analysis, analyse, transcript_text
from .audio_input import room_options as caller_audio_options
from .budget import (
    RATE_INSTRUCTIONS,
    WARN_INSTRUCTIONS,
    CallBudget,
    effective_ceiling,
    RateCeiling,
    SentenceGate,
    Stage,
)
from .call_control import (
    VOICEMAIL_INSTRUCTIONS,
    CallOutcome,
    Closing,
    classify_dial_failure,
    end_call_tool,
    outbound_trunk_id,
    suppress_end_call_reply,
    transfer_tool,
)
from .call_writer import CallWriter
from .config import AgentConfig
from .control_plane import ControlPlane
from .evals import execute_run
from .greeting import plan_opening, speak_opening
from .knowledge import knowledge_tool
from .latency import LatencyTracker
from .live_stats import TOPIC as STATS_TOPIC
from .live_stats import LiveStats
from .costs import actual_cost
from .realtime_stt import RealtimeSTT, find_realtime_stt
from .resolve import (
    CallIdentity,
    JobMeta,
    OutOfCreditFailure,
    ResolutionFailed,
    resolve_call,
    sip_numbers,
)
from .recording import RecordingStorage, start_recording
from .telephony import TelephonyConfig
from .tools import customer_tools
from .variables import clean

logger = logging.getLogger("automitra.agent")

SILENCE_CHECK_INSTRUCTIONS = (
    "The caller has gone quiet. Briefly check they are still there, in the "
    "language of the conversation. One short sentence."
)
SILENCE_GOODBYE_INSTRUCTIONS = (
    "The caller has not answered. Say a short goodbye, in the language of the "
    "conversation, and nothing else."
)
# How long after the last key press the digits entered so far are passed on.
KEYPAD_SETTLE_SECONDS = 1.5

# How often the live stats reach a browser watching the call.
STATS_INTERVAL_SECONDS = 1.0

# Each job's post-call step, by job id, for the server's on_session_end hook
# to find. A module-level table is safe because every job runs in a process of
# its own.
_POST_CALL: dict[str, Callable[[], Awaitable[None]]] = {}


async def on_session_end(ctx: JobContext) -> None:
    """Run the finished call's post-call step, if it registered one.

    The SDK gives this minutes, where shutdown callbacks get seconds, and runs
    it before them -- which is what lets the analysis be finalised with the
    call rather than trail it.
    """
    step = _POST_CALL.pop(ctx.job.id, None)
    if step is not None:
        await step()


class VoiceAssistant(Agent):
    """The agent a call runs, optionally held under a per-minute cost ceiling.

    With a ceiling, every reply passes through a :class:`SentenceGate` on its
    way out of the model, so a sentence the ceiling cannot afford is never
    synthesised -- and, being dropped here rather than after synthesis, never
    enters the transcript or the model's memory of what it said either.
    Everything that reaches synthesis, replies and fixed lines alike, is
    counted on the way in.

    Mid-call steering (``steering``) goes at the *end* of each request rather
    than into the system prompt. The model server caches the longest prefix a
    request shares with earlier ones; rewriting the system prompt, which comes
    first, would throw that away for the whole conversation on every change.
    """

    def __init__(
        self,
        instructions: str,
        tools: list[Any] | None = None,
        *,
        ceiling: RateCeiling | None = None,
        elapsed: Callable[[], float] | None = None,
    ) -> None:
        super().__init__(instructions=instructions, tools=tools or [])
        self._ceiling = ceiling
        self._elapsed = elapsed or (lambda: 0.0)
        # Appended to each request while set; see the class docstring.
        self.steering = ""

    async def llm_node(
        self,
        chat_ctx: llm_api.ChatContext,
        tools: list[llm_api.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterator[llm_api.ChatChunk | str | FlushSentinel]:
        if self.steering:
            # A copy, so the note shapes this reply without entering history.
            chat_ctx = chat_ctx.copy()
            chat_ctx.add_message(role="system", content=[self.steering])
        stream = Agent.default.llm_node(self, chat_ctx, tools, model_settings)
        if self._ceiling is None:
            async for chunk in stream:
                yield chunk
            return

        self._ceiling.begin_reply()
        gate = SentenceGate(self._ceiling, self._elapsed)
        if not await gate.may_request():
            # A request is billed whether or not its reply is spoken, so one
            # the ceiling cannot afford is not made at all.
            logger.warning("rate ceiling: no room for a model request; skipping this turn")
            self._ceiling.skipped_requests += 1
            await stream.aclose()
            return

        async for chunk in stream:
            if isinstance(chunk, str):
                text, passthrough = chunk, None
            elif isinstance(chunk, llm_api.ChatChunk) and chunk.delta and chunk.delta.content:
                text = chunk.delta.content
                # Tool calls and usage ride on the same chunk; they go on
                # whatever happens to the text.
                rest = chunk.delta.model_copy(update={"content": None})
                keep = bool(rest.tool_calls) or chunk.usage is not None
                passthrough = chunk.model_copy(update={"delta": rest}) if keep else None
            else:
                text, passthrough = "", chunk
            if passthrough is not None:
                yield passthrough
            for sentence in gate.split(text):
                if await gate.admit(sentence):
                    yield sentence
        for sentence in gate.rest():
            if await gate.admit(sentence):
                yield sentence

        if gate.dropped_chars:
            self._ceiling.held_back_chars += gate.dropped_chars
            logger.info(
                "rate ceiling: held back %d of %d characters of a reply",
                gate.dropped_chars,
                gate.dropped_chars + gate.released_chars,
            )

    async def tts_node(
        self, text: AsyncIterable[str], model_settings: ModelSettings
    ) -> AsyncIterator[rtc.AudioFrame]:
        if self._ceiling is None:
            source = text
        else:
            source = self._counted(text, self._ceiling)
        async for frame in Agent.default.tts_node(self, source, model_settings):
            yield frame

    @staticmethod
    async def _counted(text: AsyncIterable[str], ceiling: RateCeiling) -> AsyncIterator[str]:
        async for chunk in text:
            ceiling.count_tts(len(chunk))
            yield chunk


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

    stt_component: stt_api.STT
    if config.stt_realtime:
        # Finalises when the session's VAD hears the caller stop; see
        # realtime_stt.py, and the flush in _run_call.
        stt_component = RealtimeSTT(
            model=config.stt_model, language=config.stt_language, mode=config.stt_mode
        )
    else:
        stt_component = sarvam.STT(
            model=config.stt_model,
            mode=config.stt_mode,
            language=config.stt_language,
        )
    llm_component: llm_api.LLM = sarvam.LLM(model=config.llm_model, **llm_kwargs)
    tts_component: tts_api.TTS = sarvam.TTS(
        model=config.tts_model,
        speaker=config.tts_speaker,
        target_language_code=config.tts_language,
        pace=config.tts_pace,
        # Raw PCM at the highest rate Sarvam streams. The plugin's default is
        # MP3 at 22.05 kHz, which the call then decodes and compresses again
        # -- to Opus for a browser, to G.711 for a phone -- and the two lossy
        # passes are audible. PCM also reaches first audio slightly sooner.
        output_audio_codec="linear16",
        speech_sample_rate=24000,
    )

    # Failover, where configured. Each adapter tries Sarvam first and moves
    # to the LiveKit Inference model when it errors or times out, so a Sarvam
    # outage degrades a call instead of silencing it.
    if config.fallback_stt:
        stt_component = stt_api.FallbackAdapter(
            [stt_component, inference.STT(model=config.fallback_stt, language=_base_language(config.stt_language))]
        )
    if config.fallback_llm:
        llm_component = llm_api.FallbackAdapter([llm_component, inference.LLM(model=config.fallback_llm)])
    if config.fallback_tts:
        fallback_tts_kwargs: dict[str, Any] = {"language": _base_language(config.tts_language)}
        if config.fallback_tts_voice:
            fallback_tts_kwargs["voice"] = config.fallback_tts_voice
        tts_component = tts_api.FallbackAdapter(
            [tts_component, inference.TTS(model=config.fallback_tts, **fallback_tts_kwargs)]
        )

    return AgentSession(
        stt=stt_component,
        llm=llm_component,
        tts=tts_component,
        vad=vad if vad is not None else load_vad(config),
        turn_handling=turn_handling,
        # Silence on both sides for this long marks the caller "away", which
        # the call reacts to by checking they are still there.
        user_away_timeout=config.silence_timeout,
    )


def _base_language(code: str) -> str:
    """"hi-IN" to "hi": other providers name languages without the region."""
    return "multi" if code == "unknown" else code.split("-")[0]


async def entrypoint(ctx: JobContext) -> None:
    telephony = TelephonyConfig.from_env()

    # Deliberately not an `async with` block, and not closed by a shutdown
    # callback either.
    #
    # The entrypoint returns as soon as the session ends, but the callback that
    # records what the call did -- the transcript flush and the usage record --
    # runs after that. Closing on the way out of a `with` block would leave
    # those writes with no session to send on, so the call would sit at
    # `in_progress` forever and never be billed.
    #
    # A shutdown callback does not solve it either: they are all started
    # together with `asyncio.gather`, so a callback that closed the client
    # would race the one still using it rather than follow it.
    #
    # So the client is closed by whoever registered the last write, in
    # `report_usage`, once it has finished with it.
    control_plane = await ControlPlane().open()

    try:
        if control_plane.configured and (eval_run_id := JobMeta.parse(ctx.job.metadata).eval_run_id):
            # Not a call: a test run dispatched from the dashboard. It needs no
            # audio, only the worker's models and the control plane.
            logger.info("running test run %s", eval_run_id)
            await execute_run(control_plane, eval_run_id)
            ctx.shutdown(reason="test run finished")
            await control_plane.aclose()
            return

        if control_plane.configured:
            # The multi-tenant path. Resolution happens before ctx.connect(),
            # so the work overlaps with WebRTC and SIP media setup rather than
            # adding to the silence before the agent speaks.
            try:
                identity = await resolve_call(ctx, control_plane)
            except OutOfCreditFailure as exc:
                # Not a fault: the account is empty. Logged as a business
                # refusal so it does not sit in the error budget alongside
                # things that are actually broken.
                logger.warning("declining the call: %s", exc)
                ctx.shutdown(reason="out of credit")
                # Nothing was recorded, so nothing later needs the client.
                await control_plane.aclose()
                return
            except ResolutionFailed as exc:
                # Nothing safe to fall back to: answering with whatever
                # configuration is at hand would put this caller through to
                # another company's script. End the call instead, loudly.
                logger.error("refusing the call: %s", exc)
                ctx.shutdown(reason="agent could not be resolved")
                await control_plane.aclose()
                return
            config = identity.config
        else:
            # No control plane configured: local development, `agent console`,
            # or a deployment still running on environment variables.
            logger.info("no control plane configured; using environment config")
            identity = None
            config = AgentConfig.from_env()

        await _run_call(ctx, config, telephony, identity, control_plane)
    except Exception:
        # Anything that escapes before the session is running leaves no
        # shutdown callback to close the client, so it is closed here.
        await control_plane.aclose()
        raise


async def _run_call(
    ctx: JobContext,
    config: AgentConfig,
    telephony: TelephonyConfig,
    identity: CallIdentity | None,
    control_plane: ControlPlane,
) -> None:
    # The call's own values -- the contact's name, what they owe -- are filled
    # into the prompt and greeting before anything is said.
    variables = clean(identity.meta.variables) if identity else {}
    config = config.with_variables(variables)
    logger.info("starting voice agent: %s", config.describe())

    session = build_session(config, vad=ctx.proc.userdata.get("vad"))
    realtime_stt = find_realtime_stt(session.stt)

    # How the call went, written by whichever part of it finds out, and read
    # once when the call record is finalised.
    outcome = CallOutcome()

    # The call record's id, once the control plane has opened one. None when
    # running on environment config, or when the record could not be written.
    call_id: str | None = None

    # The phone leg's participant identity, once there is one. It is what a
    # transfer moves; a browser test call never has one.
    phone_identity: str | None = None

    # Set once the call record exists. Until then there is nowhere to write
    # events, so they are recorded against nothing and dropped -- which only
    # covers the moments before the far end has even joined.
    writer: CallWriter | None = None

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

    tools: list[Any] = []
    if config.end_call_enabled:
        closing = (
            Closing(config.closing_lines, config.timezone, variables)
            if config.closing_lines
            else None
        )
        tools.append(end_call_tool(outcome, closing))
    if identity is not None and identity.meta.place_call:
        # A call placed to a business may meet a phone menu; this lets the
        # agent press keys to get through it.
        tools.append(send_dtmf_events)
    if config.transfer_targets:
        tools.append(
            transfer_tool(
                config.transfer_targets,
                outcome=outcome,
                room_name=lambda: ctx.room.name,
                phone_identity=lambda: phone_identity,
                lk=lambda: ctx.api,
                on_transfer=lambda target, status, error: record(
                    transcript.transfer_event(target.name, target.number, status, error)
                ),
            )
        )
    if identity is not None:
        tools.extend(customer_tools(list(identity.agent.tools), call_id=lambda: call_id))
        if identity.agent.has_knowledge:
            agent = identity.agent
            tools.append(
                knowledge_tool(
                    lambda query: control_plane.search_knowledge(
                        agent.agent_version_id, agent.org_id, query
                    )
                )
            )

    # Tally real usage so the call can be costed from measured numbers rather
    # than an assumed conversation shape.
    usage = metrics.UsageCollector()

    # The organisation was checked as solvent when the agent was resolved, but
    # a balance is only good for what is in it. Capping the call's own ceiling
    # to what remains bounds how far one long call can overdraw between that
    # check and the charge at the end.
    limit_inr = config.budget_inr
    available = identity.agent.available_inr if identity else None
    if available is not None:
        limit_inr = available if limit_inr <= 0 else min(limit_inr, available)
        logger.info("call ceiling capped to the remaining balance: Rs %.2f", limit_inr)

    budget = CallBudget(
        limit_inr=limit_inr,
        stt_model=config.stt_model,
        tts_model=config.tts_model,
        llm_model=config.llm_model,
        warn_at=config.budget_warn_at,
        wrap_at=config.budget_wrap_at,
    )
    try:
        budget.validate()
    except ValueError as exc:
        # A balance too small to hold a conversation. Better to say so than to
        # answer and wrap up two sentences later.
        logger.error("refusing the call: %s", exc)
        ctx.shutdown(reason="insufficient balance")
        return

    # Every call runs under a per-minute ceiling, and it cannot be switched
    # off: an agent may ask for a lower one, never for more than the platform's.
    rate_ceiling = RateCeiling(
        ceiling_inr_per_min=effective_ceiling(config.max_inr_per_min),
        stt_model=config.stt_model,
        tts_model=config.tts_model,
        llm_model=config.llm_model,
    )
    rate_ceiling.validate()
    # Reset when an outbound call is answered, so ringing is neither billed
    # nor counted against the per-minute rate.
    started_at = time.monotonic()
    logger.info(
        "rate ceiling: Rs %.2f/min (Rs %.2f/min of that is speech-to-text, "
        "which is fixed)",
        rate_ceiling.ceiling_inr_per_min,
        rate_ceiling.stt_inr_per_min,
    )

    def elapsed() -> float:
        return time.monotonic() - started_at

    assistant = VoiceAssistant(
        config.instructions, tools, ceiling=rate_ceiling, elapsed=elapsed
    )

    def refresh_instructions() -> None:
        """Apply whichever steering the budget and the ceiling currently call for.

        Built from both each time, so relaxing one never drops the other. The
        system prompt itself is left alone so the model's prompt cache holds.
        """
        notes = []
        if budget.stage >= Stage.WARN:
            notes.append(WARN_INSTRUCTIONS.strip())
        if rate_ceiling.tightened:
            notes.append(RATE_INSTRUCTIONS.strip())
        assistant.steering = "\n\n".join(notes)

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

    # How long the caller waited for each reply.
    latency = LatencyTracker()
    # The same figures and more, live, for a developer watching a test call.
    stats = LiveStats(
        stt_model=config.stt_model,
        llm_model=config.llm_model,
        tts_model=config.tts_model,
        tts_speaker=config.tts_speaker,
        stt_language=config.stt_language,
    )

    # Set once the greeting is queued. Before that, silence is ringing or the
    # answering-machine check, not a caller who has gone quiet.
    conversing = asyncio.Event()
    silence = {"checks": 0}

    # Why the session ended, as the SDK reports it. Captured rather than
    # inferred: the budget stage is OK on any normal call, so using it would
    # label every ordinary hang-up "ok" and say nothing about what happened.
    ended_because: dict[str, str] = {}
    # When the line closed, so the duration billed excludes the post-call
    # analysis that runs afterwards.
    timing: dict[str, float] = {}
    # What is known only once the call is under way or over: the recording's
    # object key and the post-call analysis.
    after_call: dict[str, Any] = {}

    async def end_on_budget(*, graceful: bool) -> None:
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
        if getattr(ev.item, "role", None) == "assistant" and getattr(ev.item, "interrupted", False):
            stats.interruptions += 1

    @session.on("function_tools_executed")
    def _on_tools(ev: Any) -> None:
        suppress_end_call_reply(ev)
        calls = list(getattr(ev, "function_calls", []) or [])
        outputs = list(getattr(ev, "function_call_outputs", []) or [])
        for row in transcript.tool_events(calls, outputs):
            record(row)
        for call, output in zip(calls, outputs + [None] * (len(calls) - len(outputs))):
            stats.on_tool(
                str(getattr(call, "name", "")),
                str(getattr(call, "arguments", "")),
                str(getattr(output, "output", "") if output is not None else ""),
                elapsed(),
            )

    @session.on("user_input_transcribed")
    def _on_heard(ev: Any) -> None:
        if getattr(ev, "is_final", False) and getattr(ev, "transcript", ""):
            stats.on_transcript(ev.transcript, getattr(ev, "language", None), elapsed())

    @session.on("agent_state_changed")
    def _on_agent_state(ev: Any) -> None:
        stats.agent_state = str(ev.new_state)

    async def hang_up() -> None:
        # Deleting the room disconnects everyone in it, including a phone
        # caller. Without this a call the agent ended -- on budget, by the
        # end_call tool, on reaching voicemail -- stays open on the carrier
        # until the far end notices the silence.
        await ctx.delete_room()

    @session.on("close")
    def _on_close(ev: Any) -> None:
        ended_because["reason"] = transcript.close_reason(ev)
        timing["ended"] = time.monotonic()
        # Hung up now rather than in a shutdown callback. The job's shutdown
        # runs the post-call analysis first, and the caller must not sit
        # through that in silence.
        asyncio.create_task(hang_up())
        # With the agent gone there is nothing left on the line, so the job
        # ends too, which analyses and records the call.
        ctx.shutdown(reason=ended_because["reason"])

    @session.on("user_state_changed")
    def _on_user_state(ev: Any) -> None:
        """Check on a caller who has gone quiet, and hang up if they have gone.

        A line left open on silence costs carrier minutes and speech-to-text
        for nothing, and a caller who put the phone down without hanging up is
        common on mobiles.
        """
        stats.user_state = str(ev.new_state)
        if ev.new_state == "speaking":
            silence["checks"] = 0
            return
        if ev.old_state == "speaking" and ev.new_state == "listening" and realtime_stt is not None:
            # The VAD has heard the caller stop: finalise the transcript now
            # rather than wait out the STT's own, longer silence.
            realtime_stt.end_of_speech()
        if ev.new_state != "away" or not conversing.is_set() or closing.is_set():
            return
        if config.silence_checks == 0:
            return
        if silence["checks"] < config.silence_checks:
            silence["checks"] += 1
            session.generate_reply(instructions=SILENCE_CHECK_INSTRUCTIONS, tool_choice="none")
            return
        closing.set()
        outcome.end_reason = "silence"
        handle = session.generate_reply(instructions=SILENCE_GOODBYE_INSTRUCTIONS, tool_choice="none")
        handle.add_done_callback(lambda _: session.shutdown())

    if config.dtmf_input:
        keypad: dict[str, Any] = {"digits": [], "flush": None}

        async def flush_keypad() -> None:
            # Keys arrive one at a time; a short pause after the last one is
            # taken as the end of what the caller is entering.
            await asyncio.sleep(KEYPAD_SETTLE_SECONDS)
            digits, keypad["digits"] = keypad["digits"], []
            if digits:
                session.generate_reply(user_input=f"[keypad: {' '.join(digits)}]")

        @ctx.room.on("sip_dtmf_received")
        def _on_dtmf(ev: rtc.SipDTMF) -> None:
            keypad["digits"].append(ev.digit)
            if keypad["flush"] is not None:
                keypad["flush"].cancel()
            keypad["flush"] = asyncio.create_task(flush_keypad())

    @session.on("error")
    def _on_error(ev: Any) -> None:
        # A transcript that simply stops is hard to account for later; the
        # reason is usually whichever component failed.
        record(transcript.error_event(getattr(ev, "error", None), getattr(ev, "source", None)))

    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent) -> None:
        metrics.log_metrics(ev.metrics)
        usage.collect(ev.metrics)
        latency.collect(ev.metrics)
        stats.on_metrics(ev.metrics, elapsed())

        if closing.is_set():
            return

        # The rate ceiling is independent of the per-call budget: it bounds
        # cost per minute rather than cost per call.
        if isinstance(ev.metrics, metrics.LLMMetrics):
            rate_ceiling.observe_request(
                ev.metrics.prompt_tokens,
                ev.metrics.prompt_cached_tokens,
                ev.metrics.completion_tokens,
            )
        rate_ceiling.observe(usage.get_summary())
        if rate_ceiling.steer(elapsed()) is not None:
            refresh_instructions()

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
            refresh_instructions()
        elif stage is Stage.WRAP:
            closing.set()
            asyncio.create_task(end_on_budget(graceful=True))
        elif stage is Stage.HARD:
            closing.set()
            asyncio.create_task(end_on_budget(graceful=False))

    async def report_usage() -> None:
        """Record what the call used, then release the client.

        The last thing that touches the control plane, so it owns closing it.
        """
        try:
            await _record_usage()
        finally:
            await control_plane.aclose()

    async def _record_usage() -> None:
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
            # Per minute of the call, not of the caller's speech: the latter
            # overstated it several times over on any call where the agent
            # did most of the talking.
            minutes = (timing.get("ended", time.monotonic()) - started_at) / 60.0
            per_min = cost.total_inr / minutes if minutes > 0 else 0.0
            logger.info(
                "session cost: Rs %.4f total over %.0fs, Rs %.3f/min "
                "(stt %.3f, tts %.3f, llm %.3f) [Sarvam list prices]",
                cost.total_inr,
                minutes * 60,
                per_min,
                cost.stt_inr,
                cost.tts_inr,
                cost.llm_inr,
            )

        if call_id is None or identity is None:
            return

        # Drain the buffer before finalizing, so the call is not marked
        # complete while the last of its transcript is still in memory.
        if writer is not None:
            await writer.aclose()

        payload: dict[str, Any] = {
            "status": outcome.status,
            # The budget stage wins when it ended the call, since "the
            # ceiling was reached" is more useful than "the session closed";
            # then whatever the call itself decided -- a transfer, a
            # voicemail, the agent hanging up; otherwise whatever the SDK
            # reported.
            "endReason": (
                budget.stage.name.lower()
                if budget.stage is not Stage.OK
                else outcome.end_reason or ended_because.get("reason")
            ),
            # To when the line closed, not to now: the post-call analysis ran
            # in between, and the caller was not on the line for it.
            "durationSeconds": (
                int(timing.get("ended", time.monotonic()) - started_at) if outcome.answered else 0
            ),
            "doNotCall": outcome.do_not_call,
            "recordingKey": after_call.get("recordingKey"),
            "latency": latency.summary(),
        }
        analysis: Analysis | None = after_call.get("analysis")
        if analysis is not None:
            payload["analysis"] = analysis.as_payload()
        # An unanswered call used nothing worth charging for, and sending
        # zeroes would still let a per-call minimum bill it.
        if outcome.answered:
            # What was used, not what it cost. The control plane holds the
            # rate cards, so it prices this -- which keeps a worker running
            # an older build from quietly billing at last month's rates, and
            # makes a pricing change one deploy rather than a fleet rollout.
            # The cost logged above is a local estimate for the operator, not
            # the figure anyone is charged.
            #
            # The analysis ran on the same model after the session, outside
            # the collector, so its tokens are added here: it is part of what
            # the call cost.
            extra_prompt = analysis.prompt_tokens if analysis else 0
            extra_cached = analysis.cached_tokens if analysis else 0
            extra_completion = analysis.completion_tokens if analysis else 0
            payload["usage"] = {
                "sttSeconds": summary.stt_audio_duration,
                "ttsCharacters": summary.tts_characters_count,
                "llmPromptTokens": summary.llm_prompt_tokens + extra_prompt,
                "llmCachedTokens": getattr(summary, "llm_prompt_cached_tokens", 0) + extra_cached,
                "llmCompletionTokens": summary.llm_completion_tokens + extra_completion,
                "sttModel": config.stt_model,
                "ttsModel": config.tts_model,
                "llmModel": config.llm_model,
            }
        await control_plane.finalize_call(call_id, payload)

    async def post_call() -> None:
        """Analyse the finished call, in the job's ``on_session_end`` hook.

        By then the line is closed and the room gone, so nobody is kept
        waiting on it -- and it still runs before the call is finalised, so
        the analysis and its tokens go out with the rest of the record.
        """
        if identity is None or not config.analysis_enabled or not outcome.answered:
            return
        text, caller_turns = transcript_text(session.history)
        # A voicemail greeting or a caller who never spoke has nothing to
        # analyse, and paying the model to say so is waste.
        if caller_turns == 0 or outcome.status == "voicemail":
            return
        after_call["analysis"] = await analyse(
            sarvam.LLM(model=config.llm_model, temperature=0.0),
            text,
            config.dispositions,
            config.analysis_fields,
            config.qa_criteria,
        )

    _POST_CALL[ctx.job.id] = post_call
    ctx.add_shutdown_callback(report_usage)
    # A second chance at hanging up, for a job ended some way that never
    # closed the session. Deleting a room twice is harmless.
    ctx.add_shutdown_callback(hang_up)

    caller_number = identity.caller_number if identity else None
    dialled_number = identity.dialled_number if identity else None

    async def open_record() -> None:
        """Open the call record, once the far end's numbers are known."""
        nonlocal call_id, writer
        if identity is None:
            return
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
                "answered": outcome.answered,
                "variables": variables,
                "campaignId": identity.meta.campaign_id,
                "contactId": identity.meta.contact_id,
                "requestId": identity.meta.request_id,
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

    async def start_recording_if_wanted() -> bool:
        """Start recording if the organisation records calls; whether it is.

        Started only once someone has answered, so ringing is never recorded,
        and the greeting then says so -- recording a caller without telling
        them is not a default anyone should inherit.
        """
        if identity is None or not identity.agent.record_calls:
            return False
        storage = RecordingStorage.from_env()
        if storage is None:
            logger.error("the organisation records calls but no RECORDING_S3_* storage is configured")
            return False
        key = await start_recording(ctx.api, ctx.room.name, identity.agent.org_id, storage)
        if key is None:
            return False
        after_call["recordingKey"] = key
        return True

    async def greet() -> None:
        opening = plan_opening(
            config.greeting,
            mode=config.greeting_mode,
            recorded=await start_recording_if_wanted(),
            notice=config.recording_notice,
            language=config.tts_language,
        )
        voice = (config.tts_model, config.tts_speaker, config.tts_language, config.tts_pace)
        speak_opening(session, opening, voice)

    await session.start(agent=assistant, room=ctx.room, room_options=caller_audio_options())

    async def publish_stats() -> None:
        """Send the live stats to anyone in the room on a browser, once a second.

        Only while a browser participant is present: a phone caller cannot
        read them, so an ordinary phone call sends nothing. A failed send is
        dropped; the next one supersedes it anyway.
        """
        while not timing.get("ended"):
            await asyncio.sleep(STATS_INTERVAL_SECONDS)
            viewers = [
                p for p in ctx.room.remote_participants.values()
                if p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_SIP
            ]
            if not viewers:
                continue
            try:
                snapshot = stats.snapshot(elapsed(), usage.get_summary(), rate_ceiling)
                await ctx.room.local_participant.publish_data(
                    json.dumps(snapshot, ensure_ascii=False), reliable=True, topic=STATS_TOPIC
                )
            except Exception as exc:
                logger.debug("live stats not sent: %s", exc)

    asyncio.create_task(publish_stats())

    if identity is not None and identity.meta.place_call:
        # The dialer's path: this worker places the call itself, so it knows
        # whether anyone answered and can listen for a machine from the very
        # first word.
        phone_identity = f"phone-{dialled_number}"
        verdict = None
        async with AsyncExitStack() as stack:
            detector: AMD | None = None
            if config.voicemail_detection:
                # Started before dialling so none of the greeting is missed.
                # It reuses the session's own Sarvam speech and language
                # models: they are built for the Indian-language greetings
                # these calls will hear, and it keeps the call on one bill.
                detector = await stack.enter_async_context(
                    AMD(
                        session,
                        llm=None,
                        stt=None,
                        participant_identity=phone_identity,
                        ivr_detection=False,
                        suppress_compatibility_warning=True,
                    )
                )

            try:
                await _dial(
                    ctx, telephony, to=dialled_number, from_=caller_number, identity=phone_identity
                )
            except Exception as exc:
                outcome.status, outcome.end_reason = classify_dial_failure(exc)
                outcome.answered = False
                logger.info("%s was not answered: %s (%s)", dialled_number, outcome.status, exc)
                # Recorded even so: an attempt that never connected is still
                # an attempt, and the dialer decides what to do next from it.
                await open_record()
                ctx.shutdown(reason=outcome.status)
                return

            started_at = time.monotonic()
            await open_record()

            # Queued now, but held back until the detector has decided -- a
            # greeting spoken over a voicemail prompt is wasted, and one
            # delayed for a person is only a beat late. Not awaited, for the
            # reason given at the end of this function.
            await greet()
            conversing.set()

            if detector is not None:
                try:
                    verdict = await detector.execute()
                except Exception:
                    # Treated as a person: hanging up on a real caller is the
                    # worse mistake.
                    logger.exception("answering machine detection failed")

        if verdict is not None:
            record(
                transcript.amd_event(
                    verdict.category.value, verdict.reason, verdict.transcript, verdict.delay
                )
            )
            if verdict.is_machine:
                await _leave_voicemail(session, config, outcome, verdict.category)
        return

    # On a phone call the agent is often in the room before the far end is:
    # inbound audio is still being negotiated. Greeting into that gap means the
    # caller misses the opening line entirely, so wait for the phone leg to
    # actually appear.
    if telephony.enabled:
        try:
            participant = await ctx.wait_for_participant()
            caller, dialled = sip_numbers(participant)
            caller_number = caller or caller_number
            dialled_number = dialled or dialled_number
            if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
                phone_identity = participant.identity
            logger.info(
                "phone call connected: %s (%s)",
                caller_number or "unknown number",
                participant.identity,
            )
        except Exception:
            logger.exception("no participant joined; greeting anyway")

    # Opened after the far end is known, so the record carries both numbers
    # from the outset rather than being patched afterwards.
    await open_record()

    # The handle this returns is deliberately not awaited.
    #
    # `generate_reply` is not a coroutine -- it queues the speech and hands
    # back a `SpeechHandle`, which resolves only once the greeting has finished
    # being spoken. On a call nobody answered there is no such moment, so
    # awaiting it holds the entrypoint open until the worker gives up and
    # cancels the job, taking the shutdown callback and the call's
    # finalisation down with it. The symptom is a call stuck at `in_progress`
    # that is never billed and whose transcript is lost.
    #
    # Queueing it is enough: the session owns the speech from here.
    await greet()
    conversing.set()


async def _dial(
    ctx: JobContext,
    telephony: TelephonyConfig,
    *,
    to: str | None,
    from_: str | None,
    identity: str,
) -> None:
    """Ring ``to`` and return once it is answered, or raise.

    Waiting for the answer is what turns busy, declined and unanswered into
    errors this side can tell apart, instead of a call that quietly never
    connects.
    """
    if not to:
        raise ValueError("an outbound call needs a number to dial")
    request = api.CreateSIPParticipantRequest(
        sip_trunk_id=await outbound_trunk_id(ctx.api, telephony.outbound_trunk_name),
        sip_call_to=to,
        room_name=ctx.room.name,
        participant_identity=identity,
        participant_name=to,
        krisp_enabled=telephony.krisp_enabled,
        wait_until_answered=True,
    )
    if from_:
        request.sip_number = from_
    if telephony.max_call_duration is not None:
        request.max_call_duration.FromSeconds(telephony.max_call_duration)
    if telephony.ringing_timeout is not None:
        request.ringing_timeout.FromSeconds(telephony.ringing_timeout)
    await ctx.api.sip.create_sip_participant(request)


async def _leave_voicemail(
    session: AgentSession, config: AgentConfig, outcome: CallOutcome, category: AMDCategory
) -> None:
    """Deal with a machine answering: leave a message if asked to, then hang up."""
    outcome.status = "voicemail"
    outcome.end_reason = f"amd_{category.value}"

    # Only a voicemail box takes a message. An IVR menu or a full mailbox
    # would not keep it, so those are simply hung up on.
    if config.voicemail_action == "leave_message" and category is AMDCategory.MACHINE_VM:
        if config.voicemail_message:
            handle = session.say(config.voicemail_message, allow_interruptions=False)
        else:
            handle = session.generate_reply(
                instructions=VOICEMAIL_INSTRUCTIONS,
                allow_interruptions=False,
                tool_choice="none",
            )
        try:
            # Awaited, unlike the greeting: something did answer, so the
            # message will finish playing or be cut off, and either way the
            # handle resolves.
            await handle
        except Exception:
            logger.exception("could not leave a voicemail")

    session.shutdown()


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
    server.rtc_session(agent_name=agent_name, on_session_end=on_session_end)(entrypoint)
    return server


def main() -> None:
    # Loaded here rather than at import: a module that reads .env on import
    # cannot be imported by anything that does not want its side effects.
    load_dotenv(".env.local")
    load_dotenv()
    _utf8_stdio()
    agents.cli.run_app(build_server())


def _utf8_stdio() -> None:
    """Write UTF-8 even when stdout is redirected on Windows.

    Redirected to a file (``uv run agent console *> call.log``), Python falls
    back to the ANSI code page, and LiveKit's first console line -- which has an
    emoji in it -- raises UnicodeEncodeError before the agent ever starts.
    Transcripts in Hindi and other Indic scripts would hit the same wall.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None and (stream.encoding or "").lower() != "utf-8":
            reconfigure(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    main()
