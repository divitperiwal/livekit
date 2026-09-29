"""What the caller's audio goes through before the VAD and speech-to-text hear it.

Background voice cancellation, not a higher VAD threshold. A caller in a
crowded room is surrounded by other people talking, and without this every
one of them is speech to the VAD: it interrupts the agent, and the STT writes
their words into the caller's turn -- which also flips the agent's language
when the room speaks Hindi to an English caller. Raising the VAD threshold
would ignore them only by also ignoring a quiet caller. BVC removes voices
other than the one closest to the microphone, so the threshold can stay low.

Automatic gain control then brings a soft-spoken caller up to a level the VAD
and STT hear reliably. The framework leaves it off when a noise-cancellation
selector is given, so it is switched on here explicitly.

Phone audio gets BVCTelephony, the model trained on narrowband calls; a
browser gets BVC. Both run on LiveKit Cloud.
"""

from __future__ import annotations

from livekit import rtc
from livekit.agents.voice import room_io
from livekit.agents.voice.room_io.types import NoiseCancellationParams
from livekit.plugins import noise_cancellation


def is_phone(participant: rtc.Participant) -> bool:
    return participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP


def pick_noise_cancellation(params: NoiseCancellationParams) -> rtc.NoiseCancellationOptions:
    """The cancellation model for one caller's track."""
    if is_phone(params.participant):
        return noise_cancellation.BVCTelephony()
    return noise_cancellation.BVC()


def room_options() -> room_io.RoomOptions:
    return room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=pick_noise_cancellation,
            auto_gain_control=True,
        )
    )
