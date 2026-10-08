import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/database";
import { calls, phoneNumbers, suppressedNumbers } from "../../db/schema";
import type { CallDispatcher } from "../../livekit";
import { versionToRun } from "../agents/resolve-call";
import { findAgent } from "../agents/agents";
import { checkCredit, type CreditCheckDependencies } from "../billing/credit-check";
import { E164 } from "../numbers/pool";
import { indianMinuteOfDay } from "../time/india";
import { withCallSlot } from "./call-slots";

export const placeCallInputSchema = z.strictObject({
  agentId: z.string(),
  to: z.string().regex(E164, "must be E.164, e.g. +919876543210"),
  /** One of the org's own numbers to call from; default: its first outbound number. */
  from: z.string().regex(E164).optional(),
  variables: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(1_000))
    .default({})
    .refine((variables) => Object.keys(variables).length <= 50, "at most 50 variables"),
});
export type PlaceCallInput = z.output<typeof placeCallInputSchema>;

/** Indian numbers are dialled only 09:00–21:00 IST (guarantee 14). */
const INDIAN_CALLING_HOURS = { fromMinute: 9 * 60, toMinute: 21 * 60 };

export function withinIndianCallingHours(number: string, at: Date): boolean {
  if (!number.startsWith("+91")) return true;
  const minute = Math.floor(indianMinuteOfDay(at));
  return minute >= INDIAN_CALLING_HOURS.fromMinute && minute < INDIAN_CALLING_HOURS.toMinute;
}

export type PlaceCallOutcome =
  | { kind: "queued"; callId: string }
  | { kind: "not_found"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "no_credit"; reason: string }
  | { kind: "concurrency_limit"; reason: string }
  | { kind: "unavailable"; reason: string };

export type PlaceCallDependencies = CreditCheckDependencies & {
  /** Null when outbound calling is not configured. */
  dispatcher: CallDispatcher | null;
  roomPrefix: string;
  random?: () => number;
};

async function isOnDoNotCallList(db: Database, orgId: string, number: string) {
  const [entry] = await db
    .select({ id: suppressedNumbers.id })
    .from(suppressedNumbers)
    .where(and(eq(suppressedNumbers.orgId, orgId), eq(suppressedNumbers.e164, number)));
  return entry !== undefined;
}

/** The org's outbound number to call from: the one asked for, else its first. */
async function findCallerId(db: Database, orgId: string, wanted: string | undefined) {
  const [number] = await db
    .select({ id: phoneNumbers.id, e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.orgId, orgId),
        eq(phoneNumbers.status, "assigned"),
        inArray(phoneNumbers.direction, ["outbound", "both"]),
        wanted ? eq(phoneNumbers.e164, wanted) : undefined,
      ),
    )
    .orderBy(asc(phoneNumbers.e164))
    .limit(1);
  return number ?? null;
}

/**
 * `POST /v1/orgs/:externalId/calls`: the same do-not-call, calling-hour and credit checks a
 * campaign makes, then a slot of the key's concurrency, then the worker is dispatched to
 * dial. The call row exists before the dispatch, so its id is what the client keeps.
 */
export async function placeCall(
  deps: PlaceCallDependencies,
  context: { org: { id: string; accountId: string; externalId: string }; apiKeyId: string },
  input: PlaceCallInput,
): Promise<PlaceCallOutcome> {
  const { db, dispatcher, now = () => new Date() } = deps;
  const { org, apiKeyId } = context;
  if (!dispatcher) return { kind: "unavailable", reason: "outbound calling is not configured" };

  const agent = await findAgent(db, org.id, input.agentId);
  if (!agent || agent.status !== "active") return { kind: "not_found", reason: "agent not found" };

  const agentVersionId = versionToRun(agent, deps.random ?? Math.random);
  if (!agentVersionId) return { kind: "rejected", reason: "agent has no live version" };

  if (await isOnDoNotCallList(db, org.id, input.to)) {
    return { kind: "rejected", reason: "the number is on the org's do-not-call list" };
  }

  if (!withinIndianCallingHours(input.to, now())) {
    return { kind: "rejected", reason: "Indian numbers can only be called 09:00–21:00 IST" };
  }

  const callerId = await findCallerId(db, org.id, input.from);
  if (!callerId) {
    const reason = input.from
      ? `${input.from} is not one of the org's outbound numbers`
      : "the org has no outbound number";
    return { kind: "rejected", reason };
  }

  const credit = await checkCredit(deps, org.accountId, org.externalId);
  if (!credit.allowed) return { kind: "no_credit", reason: credit.reason };

  const call = {
    id: crypto.randomUUID(),
    orgId: org.id,
    agentId: agent.id,
    agentVersionId,
    toNumber: input.to,
    fromNumber: callerId.e164,
    phoneNumberId: callerId.id,
    variables: input.variables,
  };

  const slot = await withCallSlot(db, apiKeyId, async (tx) => {
    await tx.insert(calls).values({
      ...call,
      requestId: call.id,
      apiKeyId,
      direction: "outbound",
      status: "queued",
    });
  });
  if (!slot.ok) {
    const reason = `this key already has ${slot.liveCalls} of ${slot.maxConcurrentCalls} live calls`;
    return { kind: "concurrency_limit", reason };
  }

  try {
    await dispatcher({
      roomName: `${deps.roomPrefix}-${randomBytes(6).toString("hex")}`,
      metadata: {
        placeCall: true,
        direction: "outbound",
        orgId: call.orgId,
        agentId: call.agentId,
        agentVersionId: call.agentVersionId,
        toNumber: call.toNumber,
        fromNumber: call.fromNumber,
        phoneNumberId: call.phoneNumberId,
        variables: call.variables,
        requestId: call.id,
      },
    });
  } catch (error) {
    console.error("dispatch failed", call.id, error);
    // Failing the row frees the key's slot; the worker never got the job.
    await db
      .update(calls)
      .set({ status: "failed", endReason: "dispatch_failed", endedAt: now(), finalizedAt: now() })
      .where(eq(calls.id, call.id));
    return { kind: "unavailable", reason: "could not reach the call service; nothing was dialled" };
  }

  return { kind: "queued", callId: call.id };
}
