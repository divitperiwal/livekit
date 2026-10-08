"""One call, once its agent is known.

    inbound    wait for the phone leg -> open the call record -> greet
    outbound   listen for a machine -> dial and wait for an answer -> open the record ->
               greet (held until the machine check decides) -> voicemail if a machine
    browser    open the call record -> greet

Recording starts once someone has answered, and the greeting then says so. When the
session ends, the SDK's session-end hook (minutes, not the seconds a shutdown callback
gets) uploads the recording and runs the post-call analysis; then the call is finalised.

`resolved` and `client` are None in single-tenant dev mode, which reports nothing.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from livekit import rtc
from livekit.agents import JobContext, utils
from livekit.agents.beta.tools.send_dtmf import send_dtmf_events
from livekit.agents.voice.amd import AMD

from automitra_worker.agent_config.runtime import RuntimeAgent
from automitra_worker.call_tools.end_call import Closing, end_call_tool, suppress_end_call_reply
from automitra_worker.call_tools.keypad import KeypadInput
from automitra_worker.call_tools.silence import (
    SILENCE_CHECK_INSTRUCTIONS,
    SILENCE_GOODBYE_INSTRUCTIONS,
    SilenceAction,
    SilenceWatch,
)
from automitra_worker.call_tools.transfer import transfer_tool
from automitra_worker.control_plane.client import ControlPlaneClient
from automitra_worker.control_plane.contract import CallDirection, OpenCallRequest
from automitra_worker.control_plane.resolution import JobMetadata, ResolvedCall, sip_numbers
from automitra_worker.cost.call_budget import Stage
from automitra_worker.cost.call_cost_control import CallCostControl
from automitra_worker.pipeline.greeting import plan_opening, speak_opening
from automitra_worker.pipeline.realtime_stt import find_realtime_stt
from automitra_worker.pipeline.session import apply_vad_options, build_analysis_llm, build_session
from automitra_worker.pipeline.voice_assistant import VoiceAssistant
from automitra_worker.reporting import call_events
from automitra_worker.reporting.analysis import AnalysisResult, analyse_call, transcript_text
from automitra_worker.reporting.call_outcome import CallOutcome
from automitra_worker.reporting.event_buffer import EventBuffer
from automitra_worker.reporting.finalize import finalize_request
from automitra_worker.reporting.latency import LatencyTracker
from automitra_worker.reporting.recording import CallRecorder, RecordingStorage, recording_key
from automitra_worker.telephony.outbound import (
    OutboundTrunk,
    classify_dial_failure,
    dial_request,
    phone_participant_identity,
)
from automitra_worker.telephony.settings import TelephonySettings
from automitra_worker.telephony.voicemail import handle_machine

logger = logging.getLogger("automitra.call")

# Each call's post-call step, by job id, for the server's session-end hook to find. Safe as
# module state only because every call runs in its own process.
POST_CALL_STEPS: dict[str, Callable[[], Awaitable[None]]] = {}


async def run_post_call_step(ctx: JobContext) -> None:
    """The AgentServer's on_session_end hook."""
    step = POST_CALL_STEPS.pop(ctx.job.id, None)
    if step is not None:
        await step()


@dataclass
class CallLine:
    """Who is on the line. `phone_identity` is the SIP participant a transfer moves; a
    browser test call has none."""

    direction: CallDirection
    caller_number: str | None
    dialled_number: str | None
    phone_identity: str | None = None


@dataclass
class CallReport:
    """What is learned as the call runs, and read once at finalize."""

    call_id: str | None = None
    events: EventBuffer | None = None
    close_reason: str | None = None
    ended_after_seconds: float | None = None
    recorder: CallRecorder | None = None
    recording_key: str | None = None
    analysis: AnalysisResult | None = None

    def record(self, row: dict | None) -> None:
        if self.events is not None:
            self.events.add(row)


def call_limit_inr(configured_budget_inr: float, available_inr: float | None) -> float:
    """The call's own budget capped to what the account can still spend, so one long call
    cannot overdraw far between the credit check and the charge."""
    if available_inr is None:
        return configured_budget_inr
    if configured_budget_inr <= 0:
        return available_inr
    return min(configured_budget_inr, available_inr)


async def run_call(
    ctx: JobContext,
    runtime_agent: RuntimeAgent,
    *,
    metadata: JobMetadata | None = None,
    telephony: TelephonySettings | None = None,
    resolved: ResolvedCall | None = None,
    client: ControlPlaneClient | None = None,
) -> None:
    config = runtime_agent.config
    available_inr = resolved.agent.available_inr if resolved else None
    if available_inr is not None and available_inr <= 0:
        # A limit of 0 would switch the budget off, making the call unbounded.
        await _refuse(ctx, client, "no credit", "the account has no credit left")
        return
    cost_control = CallCostControl(
        config, limit_inr=call_limit_inr(config.budget_inr, available_inr)
    )
    try:
        cost_control.validate()
    except ValueError as error:
        await _refuse(ctx, client, "call budget too small", str(error))
        return

    call = Call(
        ctx,
        runtime_agent,
        cost_control,
        metadata=metadata or (resolved.metadata if resolved else JobMetadata()),
        telephony=telephony or TelephonySettings.from_environment(),
        resolved=resolved,
        client=client,
    )
    await call.run()


class Call:
    def __init__(
        self,
        ctx: JobContext,
        runtime_agent: RuntimeAgent,
        cost_control: CallCostControl,
        *,
        metadata: JobMetadata,
        telephony: TelephonySettings,
        resolved: ResolvedCall | None,
        client: ControlPlaneClient | None,
    ) -> None:
        self._ctx = ctx
        self._agent = runtime_agent
        self._config = runtime_agent.config
        self._cost_control = cost_control
        self._metadata = metadata
        self._telephony = telephony
        self._resolved = resolved
        self._client = client
        self._variables = metadata.variables or {}

        self.outcome = CallOutcome()
        self.report = CallReport()
        self.line = CallLine(
            direction=resolved.direction
            if resolved
            else ("outbound" if metadata.place_call else "inbound"),
            caller_number=resolved.caller_number if resolved else metadata.from_number,
            dialled_number=resolved.dialled_number if resolved else metadata.to_number,
        )
        self._latency = LatencyTracker()
        self._silence = SilenceWatch(self._config.silence_checks)
        # Set once the greeting is queued: silence before that is ringing, not a quiet caller.
        self._conversing = asyncio.Event()
        # Set once the call starts ending; nothing may start ending it a second time.
        self._ending = asyncio.Event()

        vad = ctx.proc.userdata["vad"]
        apply_vad_options(vad, self._config)
        self._session = build_session(self._config, vad)
        self._realtime_stt = find_realtime_stt(self._session.stt)
        self._assistant = VoiceAssistant(
            runtime_agent.instructions,
            tools=self._tools(),
            ceiling=cost_control.ceiling,
            elapsed=cost_control.elapsed,
        )
        self._listen()

    async def run(self) -> None:
        POST_CALL_STEPS[self._ctx.job.id] = self._after_session
        self._ctx.add_shutdown_callback(self._finish)
        # record=False: the SDK's own recording also uploads every call to LiveKit Cloud.
        await self._session.start(agent=self._assistant, room=self._ctx.room, record=False)

        if self._metadata.place_call:
            await self._place_outbound_call()
            return
        if self._telephony.enabled:
            await self._wait_for_phone_leg()
        # Opened once the far end is known, so the record carries both numbers.
        await self._open_record()
        self._greet(recorded=await self._start_recording_if_wanted())

    # The call's tools

    def _tools(self) -> list[Any]:
        config = self._config
        tools: list[Any] = []
        if config.end_call_enabled:
            closing = (
                Closing(tuple(config.closing_lines), config.timezone, self._variables)
                if config.closing_lines
                else None
            )
            tools.append(end_call_tool(self.outcome, closing))
        if self._metadata.place_call:
            # A call placed to a business may meet a phone menu.
            tools.append(send_dtmf_events)
        if config.transfer_targets:
            tools.append(
                transfer_tool(
                    tuple(config.transfer_targets),
                    outcome=self.outcome,
                    room_name=lambda: self._ctx.room.name,
                    phone_identity=lambda: self.line.phone_identity,
                    livekit_api=lambda: self._ctx.api,
                    on_transfer=lambda target, status, error: self.report.record(
                        call_events.transfer_event(target.name, target.number, status, error)
                    ),
                )
            )
        return tools

    # Session events

    def _listen(self) -> None:
        session = self._session
        session.on("metrics_collected", self._on_metrics_collected)
        session.on(
            "conversation_item_added",
            lambda event: self.report.record(call_events.conversation_item(event.item)),
        )
        session.on("function_tools_executed", self._on_function_tools_executed)
        session.on(
            "error",
            lambda event: self.report.record(
                call_events.error_event(
                    getattr(event, "error", None), getattr(event, "source", None)
                )
            ),
        )
        session.on("user_state_changed", self._on_user_state_changed)
        session.on("close", self._on_close)
        if self._config.dtmf_input:
            keypad = KeypadInput(lambda message: session.generate_reply(user_input=message))
            self._ctx.room.on("sip_dtmf_received", lambda event: keypad.press(event.digit))

    def _on_metrics_collected(self, event: Any) -> None:
        self._latency.collect(event.metrics)
        moved_to = self._cost_control.on_metrics(event.metrics)
        if moved_to is not None:
            budget = self._cost_control.budget
            self.report.record(
                call_events.stage_event(moved_to.name, budget.spent_inr, budget.limit_inr)
            )
        if moved_to is Stage.HARD:
            # The backstop: close now, even mid-farewell.
            self._ending.set()
            asyncio.create_task(self._end_on_budget(graceful=False))
            return
        if self._ending.is_set():
            return
        self._assistant.steering = self._cost_control.steering()
        if moved_to is Stage.WRAP:
            self._ending.set()
            asyncio.create_task(self._end_on_budget(graceful=True))

    def _on_function_tools_executed(self, event: Any) -> None:
        suppress_end_call_reply(event)
        for row in call_events.tool_events(
            list(getattr(event, "function_calls", []) or []),
            list(getattr(event, "function_call_outputs", []) or []),
        ):
            self.report.record(row)

    def _on_user_state_changed(self, event: Any) -> None:
        if event.new_state == "speaking":
            self._silence.caller_spoke()
            return
        if event.old_state == "speaking" and event.new_state == "listening" and self._realtime_stt:
            # The VAD heard the caller stop: finalise now rather than wait out the STT's
            # own, longer silence.
            self._realtime_stt.end_of_speech()
        if event.new_state != "away" or not self._conversing.is_set() or self._ending.is_set():
            return
        action = self._silence.caller_away()
        if action is SilenceAction.CHECK:
            self._session.generate_reply(
                instructions=SILENCE_CHECK_INSTRUCTIONS, tool_choice="none"
            )
        elif action is SilenceAction.GOODBYE:
            self._ending.set()
            self.outcome.end_reason = "silence"
            goodbye = self._session.generate_reply(
                instructions=SILENCE_GOODBYE_INSTRUCTIONS, tool_choice="none"
            )
            goodbye.add_done_callback(lambda _: self._session.shutdown())

    def _on_close(self, event: Any) -> None:
        self.report.close_reason = call_events.close_reason(event)
        self.report.ended_after_seconds = self._cost_control.elapsed()
        # Deleting the room hangs up a phone caller; done now, not after the post-call work.
        asyncio.create_task(self._hang_up())
        self._ctx.shutdown(reason=self.report.close_reason)

    # The phone line

    async def _wait_for_phone_leg(self) -> None:
        """The agent is often in the room before the caller's audio is: greeting into that
        gap means the caller misses the opening line."""
        try:
            participant = await self._ctx.wait_for_participant()
        except Exception:
            logger.exception("no participant joined; greeting anyway")
            return
        caller, dialled = sip_numbers(dict(participant.attributes or {}))
        self.line.caller_number = caller or self.line.caller_number
        self.line.dialled_number = dialled or self.line.dialled_number
        if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
            self.line.phone_identity = participant.identity
        logger.info(
            "phone call connected: %s (%s)",
            self.line.caller_number or "unknown number",
            participant.identity,
        )

    async def _place_outbound_call(self) -> None:
        to_number = self.line.dialled_number
        if not to_number:
            logger.error("an outbound job carried no number to dial")
            self._ctx.shutdown(reason="no number to dial")
            return
        self.line.phone_identity = phone_participant_identity(to_number)
        verdict = None
        async with AsyncExitStack() as stack:
            detector = None
            if self._config.voicemail_detection:
                # Listening from before the dial, so none of the greeting is missed. It
                # reuses the session's Sarvam models, built for Indian-language greetings.
                detector = await stack.enter_async_context(
                    AMD(
                        self._session,
                        llm=None,
                        stt=None,
                        participant_identity=self.line.phone_identity,
                        ivr_detection=False,
                        suppress_compatibility_warning=True,
                    )
                )
            try:
                trunk_id = await OutboundTrunk(self._telephony).trunk_id(self._ctx.api)
                await self._ctx.api.sip.create_sip_participant(
                    dial_request(
                        self._telephony,
                        trunk_id=trunk_id,
                        room_name=self._ctx.room.name,
                        to_number=to_number,
                        from_number=self.line.caller_number,
                        participant_identity=self.line.phone_identity,
                    )
                )
            except Exception as error:
                self.outcome.status, self.outcome.end_reason = classify_dial_failure(error)
                self.outcome.answered = False
                logger.info("%s was not answered: %s (%s)", to_number, self.outcome.status, error)
                # Recorded even so: the dialer decides what to do next from the attempt.
                await self._open_record()
                self._ctx.shutdown(reason=self.outcome.status)
                return

            # Ringing is neither billed nor counted against the per-minute rate.
            self._cost_control.restart_clock()
            await self._open_record()
            recorded = await self._start_recording_if_wanted()
            # Queued now, held back until the detector decides: a greeting spoken over a
            # voicemail prompt is wasted, one delayed for a person is only a beat late.
            self._greet(recorded=recorded)
            if detector is not None:
                try:
                    verdict = await detector.execute()
                except Exception:
                    # Treated as a person: hanging up on a real caller is the worse mistake.
                    logger.exception("answering machine detection failed")

        if verdict is not None:
            self.report.record(
                call_events.amd_event(
                    verdict.category.value, verdict.reason, verdict.transcript, verdict.delay
                )
            )
            if verdict.is_machine:
                self._ending.set()
                await handle_machine(self._session, self._config, self.outcome, verdict.category)

    async def _hang_up(self) -> None:
        try:
            await self._ctx.delete_room()
        except Exception:
            logger.exception("could not delete the room")

    # Speaking

    def _greet(self, *, recorded: bool) -> None:
        """A recorded call always says so in its opening."""
        config = self._config
        opening = plan_opening(
            self._agent.greeting,
            mode=config.greeting_mode,
            recorded=recorded,
            notice=config.recording_notice,
            language=config.tts_language,
        )
        voice = (config.tts_model, config.tts_speaker, config.tts_language, config.tts_pace)
        # Not awaited: on a call nobody answers the handle never resolves.
        speak_opening(self._session, opening, voice)
        self._conversing.set()

    async def _end_on_budget(self, *, graceful: bool) -> None:
        if graceful:
            try:
                # budget_farewell is an instruction, not words to read aloud.
                await self._session.generate_reply(
                    instructions=self._config.budget_farewell,
                    tool_choice="none",
                    allow_interruptions=False,
                )
            except Exception:
                logger.exception("budget farewell failed; closing anyway")
        await self._session.aclose()

    # Recording and the post-call step

    async def _start_recording_if_wanted(self, storage: RecordingStorage | None = None) -> bool:
        """Whether the call is being recorded. A recorder that will not start leaves the
        call unrecorded, and the greeting does not claim otherwise: dropping a call over
        it would trade a recording for an outage."""
        if self._resolved is None or not self._resolved.agent.record_calls:
            return False
        storage = storage or RecordingStorage.from_environment()
        if storage is None:
            logger.error(
                "the organisation records calls but no RECORDING_S3_* storage is configured"
            )
            return False
        recorder = CallRecorder(
            storage,
            recording_key(storage, self._resolved.agent.org_id, self._ctx.room.name),
            Path(self._ctx.session_directory) / "recording.ogg",
        )
        try:
            started = await recorder.start(self._session)
        except Exception:
            logger.exception("could not start recording")
            return False
        if started:
            self.report.recorder = recorder
        return started

    async def _finish_recording(self) -> None:
        """Only after the upload succeeds does the call carry the key."""
        if self.report.recorder is None:
            return
        try:
            key = await self.report.recorder.finish(utils.http_context.http_session())
        except Exception:
            logger.exception("could not finish the recording")
            return
        self.report.recording_key = key

    async def _after_session(self) -> None:
        await self._finish_recording()
        config = self._config
        if self._resolved is None or not config.analysis_enabled or not self.outcome.answered:
            return
        transcript, caller_turns = transcript_text(self._session.history)
        # A voicemail greeting, or a caller who never spoke, has nothing to analyse.
        if caller_turns == 0 or self.outcome.status == "voicemail":
            return
        self.report.analysis = await analyse_call(
            build_analysis_llm(config),
            transcript,
            list(config.dispositions),
            list(config.analysis_fields),
            list(config.qa_criteria),
        )

    # Reporting

    async def _open_record(self) -> None:
        if self._resolved is None or self._client is None:
            return
        opened = await self._client.open_call(
            open_call_request(self._ctx, self._resolved, self.line, self.outcome)
        )
        if opened is None:
            return
        self.report.call_id = opened.id
        self.report.events = EventBuffer(
            self._client, call_id=opened.id, org_id=self._resolved.agent.org_id
        )
        self.report.events.start()
        logger.info("call record %s", opened.id)

    async def _finish(self) -> None:
        """The last thing that touches the API, so it owns closing the client."""
        _log_cost(self._cost_control)
        try:
            # Normally done in the session-end hook already; this catches a job that
            # ended without running it.
            await self._finish_recording()
            if self.report.events is not None:
                # Drained first, so the call is not marked complete with events in memory.
                await self.report.events.aclose()
            if self._client is not None and self.report.call_id is not None:
                ended_after = self.report.ended_after_seconds
                await self._client.finalize_call(
                    self.report.call_id,
                    finalize_request(
                        outcome=self.outcome,
                        budget=self._cost_control.budget,
                        close_reason=self.report.close_reason,
                        duration_seconds=self._cost_control.elapsed()
                        if ended_after is None
                        else ended_after,
                        latency=self._latency.summary(),
                        usage=self._cost_control.usage,
                        recording_key=self.report.recording_key,
                        analysis=self.report.analysis,
                    ),
                )
        finally:
            if self._client is not None:
                await self._client.aclose()


def open_call_request(
    ctx: JobContext, resolved: ResolvedCall, line: CallLine, outcome: CallOutcome
) -> OpenCallRequest:
    agent, metadata = resolved.agent, resolved.metadata
    return OpenCallRequest(
        org_id=agent.org_id,
        agent_id=agent.agent_id,
        agent_version_id=agent.agent_version_id,
        lk_room_name=ctx.room.name,
        lk_job_id=ctx.job.id,
        direction=line.direction,
        from_number=line.caller_number,
        to_number=line.dialled_number,
        phone_number_id=metadata.phone_number_id,
        answered=outcome.answered,
        variables=metadata.variables or {},
        campaign_id=metadata.campaign_id,
        contact_id=metadata.contact_id,
        request_id=metadata.request_id,
    )


async def _refuse(
    ctx: JobContext, client: ControlPlaneClient | None, reason: str, detail: str
) -> None:
    logger.error("refusing the call: %s", detail)
    ctx.shutdown(reason=reason)
    if client is not None:
        await client.aclose()


def _log_cost(cost_control: CallCostControl) -> None:
    cost = cost_control.cost_so_far()
    minutes = cost_control.elapsed() / 60
    logger.info(
        "call cost: Rs %.4f over %.0fs, Rs %.3f/min (stt %.3f, tts %.3f, llm %.3f) [Sarvam list prices]",
        cost.total_inr,
        minutes * 60,
        cost.total_inr / minutes if minutes else 0.0,
        cost.stt_inr,
        cost.tts_inr,
        cost.llm_inr,
    )
