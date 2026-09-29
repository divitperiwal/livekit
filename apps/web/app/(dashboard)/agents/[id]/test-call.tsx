"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";

import { startTestCall } from "./actions";
import { DevStats, STATS_TOPIC, type LiveStats } from "./dev-stats";

type Phase = "idle" | "connecting" | "live" | "ended";

/**
 * Talks to the agent from the browser.
 *
 * The same path a phone call takes minus the carrier, so what happens here is
 * what would happen on a real call: the agent is dispatched with this
 * organisation's metadata, resolves its configuration, and the transcript and
 * billing land exactly as they would.
 *
 * Audio only. A voice agent has nothing to show, and asking for camera
 * permission to prove otherwise is a poor trade.
 */
export function TestCall({ agentId }: { agentId: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [stats, setStats] = useState<LiveStats | null>(null);

  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Leaving a room open holds the microphone and keeps billing, so it has to
  // be closed if this component goes away for any reason.
  useEffect(() => {
    return () => {
      void roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== "live") return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const hangUp = useCallback(async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setPhase("ended");
  }, []);

  async function connect() {
    setError(null);
    setPhase("connecting");
    setSeconds(0);
    setStats(null);

    const result = await startTestCall(agentId);
    if ("error" in result) {
      setError(result.error);
      setPhase("idle");
      return;
    }

    const room = new Room({ adaptiveStream: false, dynacast: false });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      // The agent's voice. Attaching to an element the browser already trusts
      // avoids the autoplay block that a freshly created one would hit.
      if (track.kind === Track.Kind.Audio && audioRef.current) {
        track.attach(audioRef.current);
      }
    });

    // The worker's live stats: the latest snapshot replaces the last.
    const decoder = new TextDecoder();
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
      if (topic !== STATS_TOPIC) return;
      try {
        setStats(JSON.parse(decoder.decode(payload)) as LiveStats);
      } catch {
        // A malformed snapshot is skipped; the next one arrives within a second.
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      roomRef.current = null;
      setPhase("ended");
    });

    try {
      await room.connect(result.url, result.token);
      // Microphone only.
      await room.localParticipant.setMicrophoneEnabled(true);
      setRoomName(result.roomName);
      setPhase("live");
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "could not connect";
      setError(
        message.toLowerCase().includes("permission") ||
          message.toLowerCase().includes("denied")
          ? "The browser blocked microphone access. Allow it and try again."
          : message,
      );
      await room.disconnect().catch(() => {});
      roomRef.current = null;
      setPhase("idle");
    }
  }

  function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    setMuted(next);
    void room.localParticipant.setMicrophoneEnabled(!next);
  }

  const minutes = Math.floor(seconds / 60);
  const clock = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} autoPlay />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-medium">Test call</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            {phase === "live"
              ? "Speak — the agent is listening. Hindi, English or a mix."
              : phase === "connecting"
                ? "Dispatching the agent…"
                : phase === "ended"
                  ? "Call ended. It appears under Calls with the full transcript."
                  : "Talk to this agent from the browser. Bills real usage, about ₹2 a minute."}
          </p>
        </div>

        {phase === "live" ? (
          <>
            <span className="tabular-nums text-sm text-neutral-500">{clock}</span>
            <button
              type="button"
              onClick={toggleMute}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              onClick={hangUp}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Hang up
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={connect}
            disabled={phase === "connecting"}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {phase === "connecting"
              ? "Connecting…"
              : phase === "ended"
                ? "Call again"
                : "Start a call"}
          </button>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {roomName && phase !== "idle" ? (
        <p className="mt-2 font-mono text-xs text-neutral-400">{roomName}</p>
      ) : null}

      {stats && phase !== "idle" ? <DevStats stats={stats} live={phase === "live"} /> : null}
    </div>
  );
}
