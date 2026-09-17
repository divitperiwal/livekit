/**
 * Resolution and call records, against a real database.
 *
 * The isolation tests here are the ones that matter. A resolution path that
 * can be talked into serving another tenant's agent is the bug class that ends
 * a business, and it is not something a type system catches.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createClient } from "../db/client";
import { agents, agentVersions, calls, orgs, phoneNumbers } from "../db/schema";
import {
  ResolutionError,
  resolveByAgentId,
  resolveByDialledNumber,
  resolveByVersionId,
} from "./agent-resolution";
import { appendEvents, finalizeCall, startCall, sweepStaleCalls } from "./calls";

const { sql, db } = createClient({ max: 2 });

/** Two organisations, so cross-tenant access is actually testable. */
const fixture = {
  orgA: "", orgB: "",
  agentA: "", agentB: "",
  versionA: "", versionB: "",
  numberA: "+915550000001",
};

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 8);

  for (const key of ["A", "B"] as const) {
    const org = (
      await db
        .insert(orgs)
        .values({ name: `Test ${key}`, slug: `test-${key.toLowerCase()}-${suffix}` })
        .returning()
    )[0]!;

    const agent = (
      await db
        .insert(agents)
        .values({ orgId: org.id, name: `Agent ${key}`, slug: `agent-${key.toLowerCase()}-${suffix}` })
        .returning()
    )[0]!;

    const version = (
      await db
        .insert(agentVersions)
        .values({
          agentId: agent.id,
          orgId: org.id,
          version: 1,
          promptMode: key === "A" ? "verbatim" : "prepend_base_rules",
          instructions: `Prompt for ${key}`,
          greeting: `Greeting ${key}`,
          config: { ttsSpeaker: "ritu" },
          publishedAt: new Date(),
        })
        .returning()
    )[0]!;

    await db
      .update(agents)
      .set({ liveVersionId: version.id })
      .where(eq(agents.id, agent.id));

    fixture[`org${key}`] = org.id;
    fixture[`agent${key}`] = agent.id;
    fixture[`version${key}`] = version.id;
  }

  fixture.numberA = `+9155500${suffix.slice(0, 5).replace(/\D/g, "0").padEnd(5, "0")}`;
  await db.insert(phoneNumbers).values({
    orgId: fixture.orgA,
    e164: fixture.numberA,
    agentId: fixture.agentA,
    status: "assigned",
  });
});

afterAll(async () => {
  // Cascades clear agents, versions, numbers and calls.
  for (const id of [fixture.orgA, fixture.orgB]) {
    await db.delete(orgs).where(eq(orgs.id, id));
  }
  await sql.end();
});

describe("resolving an agent", () => {
  test("by version id", async () => {
    const resolved = await resolveByVersionId(db, fixture.versionA);
    expect(resolved.agentVersionId).toBe(fixture.versionA);
    expect(resolved.promptMode).toBe("verbatim");
    expect(resolved.instructions).toBe("Prompt for A");
  });

  test("by agent id, giving whatever is live", async () => {
    const resolved = await resolveByAgentId(db, fixture.agentA);
    expect(resolved.agentVersionId).toBe(fixture.versionA);
  });

  test("by the number that was dialled", async () => {
    const resolved = await resolveByDialledNumber(db, fixture.numberA);
    expect(resolved.agentId).toBe(fixture.agentA);
    expect(resolved.orgId).toBe(fixture.orgA);
  });

  test("carries promptMode, which lives beside the prompt", async () => {
    // Read from its own column rather than the config blob: the two are
    // edited together, and a mode pointing at a different prompt is
    // meaningless. Losing it silently prepends the shared voice rules to a
    // script written to exclude them.
    expect((await resolveByVersionId(db, fixture.versionA)).promptMode).toBe("verbatim");
    expect((await resolveByVersionId(db, fixture.versionB)).promptMode).toBe(
      "prepend_base_rules",
    );
  });
});

describe("tenant isolation", () => {
  test("refuses a version claimed by the wrong org", async () => {
    // The job said org B; the version belongs to org A. Serving it would hand
    // one tenant another tenant's prompt.
    expect(resolveByVersionId(db, fixture.versionA, fixture.orgB)).rejects.toThrow(
      ResolutionError,
    );
  });

  test("refuses an agent claimed by the wrong org", async () => {
    expect(resolveByAgentId(db, fixture.agentA, fixture.orgB)).rejects.toThrow(
      ResolutionError,
    );
  });

  test("allows the org that actually owns it", async () => {
    const resolved = await resolveByVersionId(db, fixture.versionA, fixture.orgA);
    expect(resolved.orgId).toBe(fixture.orgA);
  });

  test("an unknown version is not found", async () => {
    expect(
      resolveByVersionId(db, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(ResolutionError);
  });

  test("an unassigned number resolves to nothing", async () => {
    expect(resolveByDialledNumber(db, "+919999999999")).rejects.toThrow(
      ResolutionError,
    );
  });
});

describe("call records", () => {
  const jobId = `JOB_${Math.random().toString(36).slice(2, 10)}`;

  test("opening the same job twice yields one record", async () => {
    // Workers get killed and their jobs retried. A second record would be a
    // second bill.
    const first = await startCall(db, {
      orgId: fixture.orgA,
      agentId: fixture.agentA,
      agentVersionId: fixture.versionA,
      lkRoomName: "room-1",
      lkJobId: jobId,
      direction: "inbound",
    });
    const second = await startCall(db, {
      orgId: fixture.orgA,
      agentId: fixture.agentA,
      agentVersionId: fixture.versionA,
      lkRoomName: "room-1-retry",
      lkJobId: jobId,
      direction: "inbound",
    });
    expect(second.id).toBe(first.id);
  });

  test("a retried flush does not duplicate the transcript", async () => {
    const call = await startCall(db, {
      orgId: fixture.orgA,
      agentId: fixture.agentA,
      agentVersionId: fixture.versionA,
      lkRoomName: "room-2",
      lkJobId: `JOB_${Math.random().toString(36).slice(2, 10)}`,
      direction: "inbound",
    });

    const events = [
      { seq: 1, type: "user_message" as const, content: "hello", at: new Date().toISOString() },
      { seq: 2, type: "agent_message" as const, content: "namaskar", at: new Date().toISOString() },
    ];

    expect(await appendEvents(db, call.id, fixture.orgA, events)).toBe(2);
    // The same flush arriving again writes nothing.
    expect(await appendEvents(db, call.id, fixture.orgA, events)).toBe(0);
  });

  test("finalizing twice writes one usage record", async () => {
    // Both the session's close handler and the shutdown callback can fire.
    const call = await startCall(db, {
      orgId: fixture.orgA,
      agentId: fixture.agentA,
      agentVersionId: fixture.versionA,
      lkRoomName: "room-3",
      lkJobId: `JOB_${Math.random().toString(36).slice(2, 10)}`,
      direction: "outbound",
    });

    const usage = {
      sttSeconds: 42.5,
      ttsCharacters: 800,
      llmPromptTokens: 5000,
      llmCachedTokens: 1000,
      llmCompletionTokens: 300,
      costInr: 1.2345,
    };

    await finalizeCall(db, call.id, { status: "completed", durationSeconds: 60, usage });
    await finalizeCall(db, call.id, { status: "completed", durationSeconds: 60, usage });

    const records = await db.query.usageRecords.findMany({
      where: (u, { eq: is }) => is(u.callId, call.id),
    });
    expect(records).toHaveLength(1);
    expect(Number(records[0]!.sttSeconds)).toBeCloseTo(42.5);
  });

  test("an unpriced call still records its usage, flagged", async () => {
    // Losing the row would be revenue that silently never existed; a flagged
    // row can be repriced once the rate card catches up.
    const call = await startCall(db, {
      orgId: fixture.orgA,
      agentId: fixture.agentA,
      agentVersionId: fixture.versionA,
      lkRoomName: "room-4",
      lkJobId: `JOB_${Math.random().toString(36).slice(2, 10)}`,
      direction: "inbound",
    });

    await finalizeCall(db, call.id, {
      status: "completed",
      usage: {
        sttSeconds: 10,
        ttsCharacters: 100,
        llmPromptTokens: 500,
        llmCachedTokens: 0,
        llmCompletionTokens: 50,
        costInr: null,
        needsReview: true,
        reviewReason: "model has no rate card entry",
      },
    });

    const record = await db.query.usageRecords.findFirst({
      where: (u, { eq: is }) => is(u.callId, call.id),
    });
    expect(record?.needsReview).toBe(true);
    expect(record?.costTotalInr).toBeNull();
  });

  test("the sweeper closes calls a worker never finished", async () => {
    // Without this they sit at in_progress forever and never bill -- invisible
    // in any dashboard, because the row looks like a call still running.
    const call = await startCall(db, {
      orgId: fixture.orgA,
      agentId: fixture.agentA,
      agentVersionId: fixture.versionA,
      lkRoomName: "room-5",
      lkJobId: `JOB_${Math.random().toString(36).slice(2, 10)}`,
      direction: "inbound",
    });
    await db
      .update(calls)
      .set({ startedAt: new Date(Date.now() - 24 * 3600 * 1000) })
      .where(eq(calls.id, call.id));

    expect(await sweepStaleCalls(db, 7200)).toBeGreaterThan(0);

    const swept = await db.query.calls.findFirst({
      where: (c, { eq: is }) => is(c.id, call.id),
    });
    expect(swept?.status).toBe("failed");
    expect(swept?.endReason).toBe("worker_lost");
  });
});
