import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { orgs, webhookDeliveries, webhookEndpoints } from "../../src/db/schema";
import { KYC_FILE_MAX_BYTES } from "../../src/modules/numbers/number-kyc";
import { createScenario } from "../http/scenario";
import { TEST_PUBLIC_BASE_URL } from "../http/test-app";
import { createV1Scenario } from "../http/v1-scenario";

function kycForm(overrides: Record<string, string | Blob | null> = {}) {
  const fields: Record<string, string | Blob | null> = {
    legalName: "Sharma Dental Clinic Pvt Ltd",
    gstin: "29ABCDE1234F1Z5",
    addressLine1: "12 MG Road",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560001",
    registrationCertificate: new File(["%PDF-1.7"], "incorporation.pdf", {
      type: "application/pdf",
    }),
    gstCertificate: new File(["PNG"], "gst.png", { type: "image/png" }),
    ...overrides,
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) form.append(name, value);
  }
  return form;
}

async function kycScenario() {
  const scenario = await createV1Scenario();
  const { api, db, account } = scenario;
  await api("PUT", "/orgs/clinic-42", { name: "Sharma Clinic" });
  await db.insert(webhookEndpoints).values({
    accountId: account.id,
    url: "https://automitra.example/hooks",
    secretCiphertext: "x",
    events: ["number_kyc.updated"],
  });
  const submit = (form = kycForm()) => api("PUT", "/orgs/clinic-42/number-kyc", form);
  const status = () => api("GET", "/orgs/clinic-42/number-kyc");
  const [org] = await db.select().from(orgs).where(eq(orgs.externalId, "clinic-42"));
  return { ...scenario, plivo: scenario.plivo!, submit, status, org: org! };
}

describe("number KYC through /v1", () => {
  test("the documents go to Plivo with a callback for this org; only the status is kept", async () => {
    const { submit, status, plivo, db, org } = await kycScenario();
    expect((await status()).body).toEqual({
      status: "none",
      rejectionReason: null,
      updatedAt: null,
    });

    const submitted = await submit();
    expect(submitted.status).toBe(202);
    expect(submitted.body).toEqual({ status: "submitted", rejectionReason: null });
    const sent = plivo.applications.get("compliance-1")!.application;
    expect(sent.callbackUrl).toStartWith(`${TEST_PUBLIC_BASE_URL}/plivo/kyc/${org.id}?token=`);
    expect(sent.documents.map((document) => document.file.fileName)).toEqual([
      "incorporation.pdf",
      "gst.png",
    ]);
    expect((await status()).body.status).toBe("submitted");
    expect(await db.$count(webhookDeliveries)).toBe(1);
  });

  test("bad details, a missing file, a wrong type or an oversized file are refused", async () => {
    const { submit, plivo } = await kycScenario();
    expect((await submit(kycForm({ gstin: "nope" }))).status).toBe(400);
    expect((await submit(kycForm({ gstCertificate: null }))).status).toBe(400);
    const wordFile = new File(["doc"], "gst.docx", { type: "application/msword" });
    expect((await submit(kycForm({ gstCertificate: wordFile }))).status).toBe(422);
    const huge = new File([new Uint8Array(KYC_FILE_MAX_BYTES + 1)], "big.pdf", {
      type: "application/pdf",
    });
    expect((await submit(kycForm({ registrationCertificate: huge }))).status).toBe(422);
    expect(plivo.calls).not.toContain("submitKyc");
  });

  test("a second submission while Plivo reviews the first is 409", async () => {
    const { submit } = await kycScenario();
    await submit();
    const again = await submit();
    expect([again.status, again.body.error]).toEqual([409, "KYC is already with Plivo for review"]);
  });
});

describe("Plivo's KYC callback", () => {
  async function callbackScenario() {
    const scenario = await kycScenario();
    await scenario.submit();
    const callbackUrl = new URL(
      scenario.plivo.applications.get("compliance-1")!.application.callbackUrl!,
    );
    const callback = (path = callbackUrl.pathname + callbackUrl.search) =>
      scenario.app.request(path, { method: "POST", body: "anything" });
    return { ...scenario, callbackUrl, callback };
  }

  test("re-reads the status from Plivo, whatever the body says", async () => {
    const { callback, plivo, status } = await callbackScenario();
    plivo.decideKyc("compliance-1", "rejected", "GST name mismatch");
    const answered = await callback();
    expect(answered.status).toBe(200);
    expect((await status()).body).toMatchObject({
      status: "rejected",
      rejectionReason: "GST name mismatch",
    });
  });

  test("a wrong token or another org's id is 404 and asks Plivo nothing", async () => {
    const { callback, callbackUrl, plivo, org } = await callbackScenario();
    const before = plivo.calls.length;
    expect((await callback(`${callbackUrl.pathname}?token=forged`)).status).toBe(404);
    const otherOrg = callbackUrl.pathname.replace(org.id, crypto.randomUUID());
    expect((await callback(otherOrg + callbackUrl.search)).status).toBe(404);
    expect(plivo.calls.length).toBe(before);
  });
});

describe("calls need accepted number KYC", () => {
  test("POST /v1/calls is 422 before acceptance, checked before credit", async () => {
    const { api, db, withOrgAndAgent } = await createV1Scenario();
    const { agentId } = await withOrgAndAgent();
    await db.update(orgs).set({ numberKycStatus: "suspended" });
    const refused = await api("POST", "/orgs/clinic-42/calls", { agentId, to: "+919876543210" });
    expect([refused.status, refused.body.error]).toEqual([422, "number KYC not accepted"]);
  });

  test.each(["suspended", "expired"] as const)(
    "an incoming call to a business whose KYC is %s is refused",
    async (status) => {
      const scenario = await createScenario();
      expect((await scenario.resolve({ number: "+918045001234" })).status).toBe(200);
      await scenario.db.update(orgs).set({ numberKycStatus: status });
      const refused = await scenario.resolve({ number: "+918045001234" });
      expect(refused.status).toBe(402);
    },
  );
});
