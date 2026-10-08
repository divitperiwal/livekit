import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { LiveKitConfig } from "./config";

/** Ends a call by closing its room; the worker then finalizes it as usual. */
export type RoomEnder = (roomName: string) => Promise<void>;

/** Sends the worker into a new room with "place this call" metadata; the worker dials. */
export type CallDispatcher = (dispatch: {
  roomName: string;
  metadata: Record<string, unknown>;
}) => Promise<void>;

export function liveKitRoomEnder(config: LiveKitConfig): RoomEnder {
  const rooms = new RoomServiceClient(
    config.LIVEKIT_URL,
    config.LIVEKIT_API_KEY,
    config.LIVEKIT_API_SECRET,
  );
  return (roomName) => rooms.deleteRoom(roomName);
}

export function liveKitCallDispatcher(
  config: LiveKitConfig & { TELEPHONY_AGENT_NAME: string },
): CallDispatcher {
  const dispatches = new AgentDispatchClient(
    config.LIVEKIT_URL,
    config.LIVEKIT_API_KEY,
    config.LIVEKIT_API_SECRET,
  );
  return async ({ roomName, metadata }) => {
    await dispatches.createDispatch(roomName, config.TELEPHONY_AGENT_NAME, {
      metadata: JSON.stringify(metadata),
    });
  };
}
