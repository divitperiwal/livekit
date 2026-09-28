/**
 * Placing one outbound call on request: the public API's `POST /v1/calls`.
 *
 * The same rules as a campaign's dialer, applied to a single call at the
 * moment it is asked for: the number must be callable, not on the
 * do-not-call list, inside the hours an Indian number may be called, and the
 * organisation must be able to pay. Each is checked here, before anything is
 * dispatched, so a refusal is an HTTP error the integration can act on rather
 * than a call record that silently failed.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client";
import { agents, phoneNumbers, suppressedNumbers } from "../db/schema";
import { indiaWindowOpen, normalizePhone } from "./campaign-rules";
import type { Dispatcher } from "./dialer";
import { standing } from "./ledger";

export class CallRequestError extends Error {
  constructor(
    message: string,
    readonly status: 402 | 404 | 409 | 422 | 503,
  ) {
    super(message);
    this.name = "CallRequestError";
  }
}

export interface CallRequest {
  agentId?: unknown;
  to?: unknown;
  fromNumberId?: unknown;
  variables?: unknown;
}

const MAX_VARIABLES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanVariables(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new CallRequestError("variables must be an object of names to values", 422);
  }
  const entries = Object.entries(raw).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length > MAX_VARIABLES) throw new CallRequestError(`at most ${MAX_VARIABLES} variables`, 422);
  return Object.fromEntries(entries.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]));
}

export async function placeCall(
  db: Database,
  dispatcher: Dispatcher,
  orgId: string,
  input: CallRequest,
  now: Date = new Date(),
) {
  const to = typeof input.to === "string" ? normalizePhone(input.to) : null;
  if (!to) throw new CallRequestError("to must be a phone number, e.g. +919876543210", 422);
  if (typeof input.agentId !== "string" || !UUID.test(input.agentId)) {
    throw new CallRequestError("agentId must be an agent's id", 422);
  }
  if (input.fromNumberId !== undefined && (typeof input.fromNumberId !== "string" || !UUID.test(input.fromNumberId))) {
    throw new CallRequestError("fromNumberId must be a phone number's id", 422);
  }
  const variables = cleanVariables(input.variables);

  const agent = (
    await db
      .select({ id: agents.id, live: agents.liveVersionId, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.orgId, orgId)))
      .limit(1)
  )[0];
  if (!agent) throw new CallRequestError("no such agent", 404);
  if (!agent.live || agent.status !== "active") throw new CallRequestError("the agent has no published version", 422);

  const numberQuery = db
    .select({ id: phoneNumbers.id, e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.orgId, orgId),
        eq(phoneNumbers.status, "assigned"),
        inArray(phoneNumbers.direction, ["outbound", "both"]),
        ...(typeof input.fromNumberId === "string" ? [eq(phoneNumbers.id, input.fromNumberId)] : []),
      ),
    )
    .orderBy(phoneNumbers.e164)
    .limit(1);
  const from = (await numberQuery)[0];
  if (!from) {
    throw new CallRequestError(
      input.fromNumberId ? "fromNumberId is not one of this organisation's numbers that can call out" : "this organisation has no number that can call out",
      422,
    );
  }

  const suppressed = await db
    .select({ id: suppressedNumbers.id })
    .from(suppressedNumbers)
    .where(and(eq(suppressedNumbers.orgId, orgId), eq(suppressedNumbers.e164, to)))
    .limit(1);
  if (suppressed.length > 0) throw new CallRequestError("that number is on the do-not-call list", 409);

  if (to.startsWith("+91") && !indiaWindowOpen(now)) {
    throw new CallRequestError("Indian numbers may only be called between 09:00 and 21:00 India time", 422);
  }

  if (!(await standing(db, orgId)).canPlaceCalls) throw new CallRequestError("no credit remaining", 402);

  const requestId = crypto.randomUUID();
  const roomName = `api-${requestId.slice(0, 12)}`;
  try {
    await dispatcher.dispatch(roomName, {
      orgId,
      agentId: agent.id,
      direction: "outbound",
      placeCall: true,
      toNumber: to,
      fromNumber: from.e164,
      phoneNumberId: from.id,
      variables,
      requestId,
    });
  } catch (error) {
    throw new CallRequestError(`could not dispatch the agent: ${(error as Error).message}`, 503);
  }

  return { requestId, to, from: from.e164, status: "dispatched" as const };
}
