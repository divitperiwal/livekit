import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { calls } from "../../src/db/schema";
import { s3RecordingLinker } from "../../src/storage";
import { TEST_NOW, TEST_RECORDINGS_URL } from "../http/test-app";
import { createV1Scenario } from "../http/v1-scenario";

const CUSTOMER = "+919876543210";
const KEY = "recordings/clinic/2026/10/call-room.ogg";

async function scenarioWithCall(options: Parameters<typeof createV1Scenario>[0] = {}) {
  const scenario = await createV1Scenario(options);
  const { agentId } = await scenario.withOrgAndAgent();
  const placed = await scenario.api("POST", "/orgs/clinic-42/calls", { agentId, to: CUSTOMER });
  const callId: string = placed.body.id;
  const setRecording = (values: Partial<typeof calls.$inferInsert>) =>
    scenario.db.update(calls).set(values).where(eq(calls.id, callId));
  return { ...scenario, callId, setRecording };
}

describe("GET /v1/orgs/:externalId/calls/:id/recording", () => {
  test("returns a link that expires in five minutes", async () => {
    const { api, callId, setRecording } = await scenarioWithCall();
    await setRecording({ recordingKey: KEY });
    const linked = await api("GET", `/orgs/clinic-42/calls/${callId}/recording`);
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({
      url: `${TEST_RECORDINGS_URL}/${KEY}?expires-in=300`,
      expiresAt: new Date(TEST_NOW.getTime() + 300_000).toISOString(),
    });
  });

  test("a call never recorded, or recorded and past retention, has no link", async () => {
    const { api, callId, setRecording } = await scenarioWithCall();
    const unrecorded = await api("GET", `/orgs/clinic-42/calls/${callId}/recording`);
    expect(unrecorded.status).toBe(404);
    expect(unrecorded.body.error).toContain("no recording");

    await setRecording({ recordingKey: KEY, recordingDeletedAt: TEST_NOW });
    const deleted = await api("GET", `/orgs/clinic-42/calls/${callId}/recording`);
    expect(deleted.status).toBe(404);
  });

  test("another org's call is not found, and the key needs calls:read", async () => {
    const { api, issue, v1, callId, setRecording, withOrgAndAgent } = await scenarioWithCall();
    await setRecording({ recordingKey: KEY });
    await withOrgAndAgent("other-org");
    const otherOrg = await api("GET", `/orgs/other-org/calls/${callId}/recording`);
    expect(otherOrg.status).toBe(404);
    expect((await api("GET", "/orgs/clinic-42/calls/not-a-uuid/recording")).status).toBe(404);

    const writeOnly = await issue({ scopes: ["calls:write"] });
    const refused = await v1(writeOnly, "GET", `/orgs/clinic-42/calls/${callId}/recording`);
    expect(refused.status).toBe(403);
  });

  test("answers 503 when recording storage is not configured", async () => {
    const { api, callId, setRecording } = await scenarioWithCall({ recordingLinker: null });
    await setRecording({ recordingKey: KEY });
    const response = await api("GET", `/orgs/clinic-42/calls/${callId}/recording`);
    expect(response.status).toBe(503);
  });
});

describe("s3RecordingLinker", () => {
  test("signs a GET for the object, offline, valid for the time asked", () => {
    const link = s3RecordingLinker({
      RECORDING_S3_BUCKET: "automitra-recordings",
      RECORDING_S3_REGION: "blr1",
      RECORDING_S3_ENDPOINT: "https://blr1.digitaloceanspaces.com",
      RECORDING_S3_ACCESS_KEY: "DO00EXAMPLE",
      RECORDING_S3_SECRET_KEY: "secret",
    })(KEY, 300);
    const url = new URL(link);
    expect(url.host).toContain("digitaloceanspaces.com");
    expect(url.pathname).toEndWith(KEY);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Credential")).toStartWith("DO00EXAMPLE/");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});
