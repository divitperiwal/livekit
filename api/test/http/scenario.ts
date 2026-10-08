import { eq } from "drizzle-orm";
import {
  accounts,
  agents,
  agentVersions,
  orgs,
  phoneNumbers,
  rateCards,
  webhookEndpoints,
} from "../../src/db/schema";
import type { CallEvent, FinalizeCallRequest, OpenCallRequest } from "../../src/contracts/internal";
import { assertWorkerAccepts } from "../contracts/worker-contract";
import { oneMinuteOfUsage, seedLikeRates } from "../fixtures/rate-card";
import { testSecretBox } from "../fixtures/secrets";
import { createTestApp } from "./test-app";

export const CLINIC_NUMBER = "+918045001234";
export const CALLER_NUMBER = "+919876543210";

type ScenarioOptions = Parameters<typeof createTestApp>[0] & {
  account?: Partial<typeof accounts.$inferInsert>;
  org?: Partial<typeof orgs.$inferInsert>;
  /** Defaults to true: a global rate card with the seed card's rules. */
  rateCard?: boolean;
};

/**
 * One account (automitra), one org with a published agent on an assigned number, a
 * global rate card and an endpoint for every event. Helpers speak the worker's side of
 * the contract and check every response against the worker's own schema.
 */
export async function createScenario(options: ScenarioOptions = {}) {
  const { app, db, internal, json } = await createTestApp(options);

  const [account] = await db
    .insert(accounts)
    .values({ slug: "automitra", name: "automitra", ...options.account })
    .returning();
  const [org] = await db
    .insert(orgs)
    .values({
      accountId: account!.id,
      externalId: "clinic-42",
      name: "Sharma Clinic",
      ...options.org,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ orgId: org!.id, name: "Receptionist", slug: "receptionist" })
    .returning();
  const [version] = await db
    .insert(agentVersions)
    .values({
      orgId: org!.id,
      agentId: agent!.id,
      version: 1,
      promptMode: "prepend_base_rules",
      instructions: "Book appointments for the clinic.",
      greeting: "Namaste, Sharma Clinic.",
      config: { ttsSpeaker: "ritu", ttsPace: 1.1 },
      publishedAt: new Date(),
    })
    .returning();
  await db.update(agents).set({ liveVersionId: version!.id }).where(eq(agents.id, agent!.id));
  const [number] = await db
    .insert(phoneNumbers)
    .values({ orgId: org!.id, e164: CLINIC_NUMBER, status: "assigned", agentId: agent!.id })
    .returning();
  if (options.rateCard !== false) {
    await db
      .insert(rateCards)
      .values({ name: "seed", rates: seedLikeRates, effectiveFrom: new Date("2026-01-01") });
  }
  await db.insert(webhookEndpoints).values({
    accountId: account!.id,
    url: "https://automitra.example/hooks",
    secretCiphertext: testSecretBox.encrypt("whsec"),
    events: ["call.ended", "usage.recorded", "account.credit_low"],
  });

  const ids = {
    accountId: account!.id,
    orgId: org!.id,
    agentId: agent!.id,
    agentVersionId: version!.id,
    phoneNumberId: number!.id,
  };

  async function resolve(query: Record<string, string | undefined>) {
    const defined = Object.entries(query).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    const response = await internal(`/resolve?${new URLSearchParams(defined)}`);
    const body: any = await response.json();
    assertWorkerAccepts(response.status === 200 ? "ResolveResponse" : "ErrorResponse", body);
    return { status: response.status, body };
  }

  function openRequest(overrides: Partial<OpenCallRequest> = {}): OpenCallRequest {
    return {
      orgId: ids.orgId,
      agentId: ids.agentId,
      agentVersionId: ids.agentVersionId,
      lkRoomName: "call-room-1",
      lkJobId: `AJ_${crypto.randomUUID()}`,
      direction: "inbound",
      fromNumber: CALLER_NUMBER,
      toNumber: CLINIC_NUMBER,
      phoneNumberId: null,
      answered: true,
      variables: {},
      campaignId: null,
      contactId: null,
      requestId: null,
      ...overrides,
    };
  }

  async function open(overrides: Partial<OpenCallRequest> = {}) {
    const request = openRequest(overrides);
    assertWorkerAccepts("OpenCallRequest", request);
    const response = await json("/calls", request);
    const body: any = await response.json();
    assertWorkerAccepts(response.ok ? "OpenCallResponse" : "ErrorResponse", body);
    return { status: response.status, body, request };
  }

  async function appendEvents(callId: string, events: CallEvent[], orgId = ids.orgId) {
    const request = { orgId, events };
    assertWorkerAccepts("AppendEventsRequest", request);
    const response = await json(`/calls/${callId}/events`, request);
    const body: any = await response.json();
    assertWorkerAccepts(response.ok ? "AppendEventsResponse" : "ErrorResponse", body);
    return { status: response.status, body };
  }

  async function finalize(callId: string, overrides: Partial<FinalizeCallRequest> = {}) {
    const request: FinalizeCallRequest = {
      status: "completed",
      endReason: "caller_hung_up",
      durationSeconds: 60,
      doNotCall: false,
      recordingKey: null,
      latency: null,
      analysis: null,
      usage: oneMinuteOfUsage,
      ...overrides,
    };
    assertWorkerAccepts("FinalizeCallRequest", request);
    const response = await json(`/calls/${callId}/finalize`, request);
    const body: any = await response.json();
    assertWorkerAccepts(response.ok ? "FinalizeCallResponse" : "ErrorResponse", body);
    return { status: response.status, body };
  }

  return { app, db, internal, ids, resolve, open, openRequest, appendEvents, finalize };
}

export const event = (seq: number, overrides: Partial<CallEvent> = {}): CallEvent => ({
  seq,
  type: "user_message",
  role: "user",
  content: `turn ${seq}`,
  payload: {},
  at: new Date(Date.UTC(2026, 9, 5, 10, 0, seq)).toISOString(),
  ...overrides,
});
