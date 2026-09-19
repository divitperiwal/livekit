/**
 * Placing a test call from the browser.
 *
 * The same path a real call takes, minus the phone network: a room is created,
 * the agent is dispatched into it with this organisation's metadata, and the
 * browser joins as the other participant. Resolution, the call record, the
 * transcript and the billing all happen exactly as they would on a phone call.
 *
 * That is the point. A test that bypassed dispatch would prove the microphone
 * works and nothing else.
 */

import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

import type { Database } from "../db/client";
import { resolveByAgentId, type ResolvedAgent } from "./agent-resolution";
import { standing } from "./ledger";

/**
 * The agent name the whole worker fleet registers under.
 *
 * A routing label for the pool, not a tenant identity -- which tenant a call
 * belongs to travels in the job metadata below.
 */
const AGENT_NAME = process.env.TELEPHONY_AGENT_NAME ?? "";

/** How long the browser has to join before the token is useless. */
const TOKEN_TTL = "10m";

export interface TestCall {
  url: string;
  token: string;
  roomName: string;
  agentSlug: string;
  agentVersionId: string;
}

export class TestCallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 404 | 503,
  ) {
    super(message);
    this.name = "TestCallError";
  }
}

function credentials() {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    throw new TestCallError(
      "LiveKit is not configured on the server (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)",
      503,
    );
  }
  return { url, key, secret };
}

export async function startTestCall(
  db: Database,
  orgId: string,
  agentId: string,
  userEmail: string,
): Promise<TestCall> {
  const { url, key, secret } = credentials();

  // Resolved here as well as by the worker, so a misconfigured agent fails in
  // the dashboard with a reason rather than as a call that connects to silence.
  let agent: ResolvedAgent;
  try {
    agent = await resolveByAgentId(db, agentId, orgId);
  } catch (error) {
    throw new TestCallError(
      error instanceof Error ? error.message : "could not resolve that agent",
      404,
    );
  }

  // A test call costs real money -- speech, tokens and voice are all billed --
  // so it is refused on the same terms as any other.
  const balance = await standing(db, orgId);
  if (!balance.canPlaceCalls) {
    throw new TestCallError(
      `no credit remaining (balance ₹${balance.balanceInr.toFixed(2)})`,
      402,
    );
  }

  const roomName = `test-${crypto.randomUUID().slice(0, 8)}`;

  // Dispatch first, so the agent is on its way into the room before the
  // browser joins. The other order greets an empty room.
  const dispatch = new AgentDispatchClient(url, key, secret);
  try {
    await dispatch.createDispatch(roomName, AGENT_NAME, {
      metadata: JSON.stringify({
        orgId,
        agentId: agent.agentId,
        agentVersionId: agent.agentVersionId,
        direction: "inbound",
      }),
    });
  } catch (error) {
    throw new TestCallError(
      `could not dispatch the agent: ${
        error instanceof Error ? error.message : "unknown error"
      }. Is a worker running?`,
      503,
    );
  }

  const token = new AccessToken(key, secret, {
    // Identifies the tester in the room, and in the call record.
    identity: `test-${userEmail}`,
    name: userEmail,
    ttl: TOKEN_TTL,
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // No data channel: this is a voice test, and a narrower grant is a
    // narrower thing to get wrong.
    canPublishData: false,
  });

  return {
    url,
    token: await token.toJwt(),
    roomName,
    agentSlug: agent.agentSlug,
    agentVersionId: agent.agentVersionId,
  };
}
