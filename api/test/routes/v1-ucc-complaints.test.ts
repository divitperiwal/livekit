import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { orgs, phoneNumbers, webhookDeliveries, webhookEndpoints } from "../../src/db/schema";
import { numberJobs } from "../../src/jobs/jobs";
import { syncUccComplaints, UCC_PROOF_MAX_BYTES } from "../../src/modules/numbers/ucc-complaints";
import { TEST_NOW } from "../http/test-app";
import { createV1Scenario, ORG_NUMBER } from "../http/v1-scenario";

const COMPLAINANT = "+919876543210";
const REFERENCE = "PUCC-2026-000000001";

async function complaintScenario(options: Parameters<typeof createV1Scenario>[0] = {}) {
  const scenario = await createV1Scenario(options);
  const { org, agentId } = await scenario.withOrgAndAgent();
  await scenario.db.insert(webhookEndpoints).values({
    accountId: scenario.account.id,
    url: "https://automitra.example/hooks",
    secretCiphertext: "x",
    events: ["ucc_complaint.updated"],
  });
  const sync = () =>
    syncUccComplaints({ db: scenario.db, plivo: scenario.plivo!, now: () => TEST_NOW });
  const events = () =>
    scenario.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event, "ucc_complaint.updated"))
      .orderBy(webhookDeliveries.createdAt);
  return { ...scenario, org, agentId, sync, events };
}

function proofForm(
  file: File = new File(["%PDF-1.7"], "consent.pdf", { type: "application/pdf" }),
) {
  const form = new FormData();
  form.append("file", file);
  return form;
}

describe("UCC complaints read from Plivo", () => {
  test("a new complaint is its org's, bars the complainant from calls, and tells the account", async () => {
    const { api, plivo, agentId, sync, events } = await complaintScenario();
    plivo!.fileComplaint({ referenceId: REFERENCE });

    expect(await sync()).toEqual({ created: 1, changed: 0, unmatched: [] });
    const listed = await api("GET", "/orgs/clinic-42/ucc-complaints");
    expect(listed.body.complaints).toEqual([
      {
        orgId: "clinic-42",
        referenceId: REFERENCE,
        status: "pending",
        fromNumber: ORG_NUMBER,
        complainantNumber: COMPLAINANT,
        calledOn: "2026-10-03",
        category: "unsolicited commercial communication",
        rejectionReason: null,
        reportedAt: "2026-10-04T05:00:00.000Z",
        proofSubmittedAt: null,
      },
    ]);

    const call = await api("POST", "/orgs/clinic-42/calls", { agentId, to: COMPLAINANT });
    expect(call.status).toBe(422);
    expect(call.body.error).toContain("do-not-call");

    const [told] = await events();
    expect(told!.payload).toMatchObject({ orgId: "clinic-42", referenceId: REFERENCE });
    expect(await sync()).toEqual({ created: 0, changed: 0, unmatched: [] });
    expect(await events()).toHaveLength(1);
  });

  test("each of Plivo's decisions reaches the account once", async () => {
    const { api, plivo, sync, events } = await complaintScenario();
    plivo!.fileComplaint({ referenceId: REFERENCE });
    await sync();
    plivo!.decideComplaint(REFERENCE, "rejected", "the opt-in date is missing");

    expect(await sync()).toEqual({ created: 0, changed: 1, unmatched: [] });
    expect(await sync()).toEqual({ created: 0, changed: 0, unmatched: [] });
    const one = await api("GET", `/orgs/clinic-42/ucc-complaints/${REFERENCE}`);
    expect(one.body).toMatchObject({
      status: "rejected",
      rejectionReason: "the opt-in date is missing",
    });
    expect((await events()).map((event) => event.payload.status)).toEqual(["pending", "rejected"]);
  });

  test("a complaint belongs to the org that held the number on the day of the call", async () => {
    const { api, db, plivo, sync } = await complaintScenario();
    const shared = "+918069000009";
    await api("PUT", "/orgs/earlier", { name: "Earlier Clinic" });
    await api("PUT", "/orgs/later", { name: "Later Clinic" });
    const orgId = async (externalId: string) =>
      (await db.select().from(orgs).where(eq(orgs.externalId, externalId)))[0]!.id;
    await db.insert(phoneNumbers).values([
      {
        e164: shared,
        orgId: await orgId("earlier"),
        status: "released",
        releasedAt: new Date("2026-10-02T10:00:00Z"),
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        e164: shared,
        orgId: await orgId("later"),
        status: "assigned",
        createdAt: new Date("2026-10-03T00:00:00Z"),
      },
    ]);
    plivo!.fileComplaint({
      referenceId: "PUCC-2026-1",
      fromNumber: shared,
      calledOn: "2026-10-01",
    });
    plivo!.fileComplaint({
      referenceId: "PUCC-2026-2",
      fromNumber: shared,
      calledOn: "2026-10-04",
    });
    await sync();

    const references = async (externalId: string) =>
      (await api("GET", `/orgs/${externalId}/ucc-complaints`)).body.complaints.map(
        (complaint: { referenceId: string }) => complaint.referenceId,
      );
    expect(await references("earlier")).toEqual(["PUCC-2026-1"]);
    expect(await references("later")).toEqual(["PUCC-2026-2"]);
  });

  test("a complaint no org can be matched to is kept and pages an operator", async () => {
    const { db, plivo, events } = await complaintScenario();
    plivo!.fileComplaint({ referenceId: REFERENCE, fromNumber: "+918000000000" });
    const lines: string[] = [];
    const job = numberJobs({ db, plivo: plivo!, now: () => TEST_NOW }, (line) =>
      lines.push(line),
    ).find((candidate) => candidate.name === "ucc-complaints")!;

    await job.run();
    expect(lines).toContain(
      `ALERT ucc-complaint-unmatched: no org held the calling number for ${REFERENCE}`,
    );
    expect(await events()).toHaveLength(0);

    plivo!.failNext("uccComplaints");
    await job.run();
    expect(lines.at(-1)).toStartWith("ALERT ucc-poll-failed");
  });
});

describe("POST /v1/orgs/:externalId/ucc-complaints/:referenceId/proof", () => {
  test("sends the proof to Plivo and puts the complaint in review", async () => {
    const { api, plivo, sync, events } = await complaintScenario();
    plivo!.fileComplaint({ referenceId: REFERENCE });
    await sync();

    const sent = await api(
      "POST",
      `/orgs/clinic-42/ucc-complaints/${REFERENCE}/proof`,
      proofForm(),
    );
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({
      status: "in_review",
      proofSubmittedAt: TEST_NOW.toISOString(),
    });
    expect(plivo!.proofs.get(REFERENCE)?.fileName).toBe("consent.pdf");
    expect(await sync()).toEqual({ created: 0, changed: 0, unmatched: [] });
    expect((await events()).map((event) => event.payload.status)).toEqual(["pending", "in_review"]);

    const again = await api(
      "POST",
      `/orgs/clinic-42/ucc-complaints/${REFERENCE}/proof`,
      proofForm(),
    );
    expect(again.status).toBe(409);
  });

  test("proof Plivo rejected can be sent again", async () => {
    const { api, plivo, sync } = await complaintScenario();
    plivo!.fileComplaint({
      referenceId: REFERENCE,
      status: "rejected",
      rejectionReason: "no logo",
    });
    await sync();
    const sent = await api(
      "POST",
      `/orgs/clinic-42/ucc-complaints/${REFERENCE}/proof`,
      proofForm(),
    );
    expect(sent.status).toBe(202);
    expect(sent.body.rejectionReason).toBeNull();
  });

  test("refuses what Plivo would refuse, and other orgs' complaints", async () => {
    const { api, issue, v1, plivo, sync, withOrgAndAgent } = await complaintScenario();
    plivo!.fileComplaint({ referenceId: REFERENCE });
    await sync();
    const path = `/orgs/clinic-42/ucc-complaints/${REFERENCE}/proof`;

    expect((await api("POST", path, new FormData())).status).toBe(400);
    const text = new File(["hi"], "consent.txt", { type: "text/plain" });
    expect((await api("POST", path, proofForm(text))).status).toBe(422);
    const huge = new File([new Uint8Array(UCC_PROOF_MAX_BYTES + 1)], "consent.pdf", {
      type: "application/pdf",
    });
    expect((await api("POST", path, proofForm(huge))).status).toBe(422);

    const unknown = "/orgs/clinic-42/ucc-complaints/PUCC-2026-404/proof";
    expect((await api("POST", unknown, proofForm())).status).toBe(404);
    await withOrgAndAgent("other-org");
    const otherOrg = `/orgs/other-org/ucc-complaints/${REFERENCE}`;
    expect((await api("GET", otherOrg)).status).toBe(404);
    expect((await api("POST", `${otherOrg}/proof`, proofForm())).status).toBe(404);

    const readOnly = await issue({ scopes: ["orgs:read"] });
    expect((await v1(readOnly, "POST", path, proofForm())).status).toBe(403);

    plivo!.decideComplaint(REFERENCE, "accepted");
    const late = await api("POST", path, proofForm());
    expect(late.status).toBe(409);
    expect(late.body.error).toContain("Plivo refused the proof");
  });

  test("answers 503 when Plivo is not configured", async () => {
    const { api } = await complaintScenario({ plivo: null });
    const sent = await api(
      "POST",
      `/orgs/clinic-42/ucc-complaints/${REFERENCE}/proof`,
      proofForm(),
    );
    expect(sent.status).toBe(503);
  });
});
