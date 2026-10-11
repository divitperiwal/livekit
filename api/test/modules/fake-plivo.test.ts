import { describe, expect, test } from "bun:test";
import type { KycApplication } from "../../src/modules/numbers/plivo";
import { FakePlivo } from "../fixtures/fake-plivo";

const application = { alias: "biz-1", documents: [] } as unknown as KycApplication;

describe("the fake Plivo keeps Plivo's rules", () => {
  test("a number is bought only under an accepted application, and only once", async () => {
    const plivo = new FakePlivo().offer("+918069000001");
    const { applicationId } = await plivo.submitKyc(application);

    await expect(plivo.buyNumber("+918069000001", applicationId)).rejects.toMatchObject({
      status: 400,
    });
    plivo.decideKyc(applicationId, "accepted");
    expect(await plivo.buyNumber("+918069000001", applicationId)).toBe("active");
    expect(await plivo.holdsNumber("+918069000001")).toBe(true);
    await expect(plivo.buyNumber("+918069000001", applicationId)).rejects.toMatchObject({
      status: 404,
    });
  });

  test("only a rejected application can be resubmitted", async () => {
    const plivo = new FakePlivo();
    const { applicationId } = await plivo.submitKyc(application);
    await expect(plivo.resubmitKyc(applicationId, application)).rejects.toMatchObject({
      plivoMessage: "compliance_not_editable",
    });
    plivo.decideKyc(applicationId, "rejected", "GST name mismatch");
    await plivo.resubmitKyc(applicationId, application);
    expect(await plivo.kycState(applicationId)).toEqual({
      status: "submitted",
      rejectionReason: null,
    });
  });

  test("failNext makes exactly the next call to that method fail", async () => {
    const plivo = new FakePlivo().failNext("releaseNumber");
    await expect(plivo.releaseNumber("+918069000001")).rejects.toMatchObject({ status: 503 });
    await plivo.releaseNumber("+918069000001");
    expect(plivo.calls).toEqual(["releaseNumber", "releaseNumber"]);
  });
});
