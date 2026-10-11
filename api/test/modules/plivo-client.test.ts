import { describe, expect, test } from "bun:test";
import {
  PLIVO_API_BASE,
  plivoClient,
  PlivoError,
  type KycApplication,
} from "../../src/modules/numbers/plivo";

const credentials = { authId: "MAAUTHID", authToken: "token" };
const accountUrl = `${PLIVO_API_BASE}/Account/MAAUTHID/`;

function plivoAnswering(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // Two copies: the test reads one body, the responder may read the other.
    requests.push(new Request(url, init));
    return respond(new Request(url, init));
  };
  const plivo = plivoClient(credentials, { fetch: fakeFetch as typeof fetch });
  return { plivo, requests };
}

const application: KycApplication = {
  alias: "automitra:biz-1",
  numberType: "local",
  callbackUrl: "https://voice.example/plivo/kyc",
  business: {
    name: "Sharma Dental Clinic Pvt Ltd",
    registrationNumber: "29ABCDE1234F1Z5",
    addressLine1: "12 MG Road",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560001",
  },
  documents: [
    {
      documentTypeId: "doc-registration-certificate",
      dataFields: { business_name: "Sharma Dental Clinic Pvt Ltd" },
      file: { fileName: "incorporation.pdf", content: new Blob(["%PDF-1"]) },
    },
    {
      documentTypeId: "doc-gst-certificate",
      dataFields: {},
      file: { fileName: "gst.png", content: new Blob(["PNG"]) },
    },
  ],
};

describe("Plivo client", () => {
  test("searches Indian voice numbers with basic auth and returns them in E.164", async () => {
    const { plivo, requests } = plivoAnswering(() =>
      Response.json({
        objects: [{ number: "918069000001", type: "local", city: "Bangalore", region: null }],
      }),
    );
    const found = await plivo.searchNumbers({ numberType: "local", pattern: "80", limit: 5 });

    expect(found).toEqual([
      {
        e164: "+918069000001",
        numberType: "local",
        city: "Bangalore",
        region: null,
        smsEnabled: false,
      },
    ]);
    const url = new URL(requests[0]!.url);
    expect(url.href.startsWith(`${accountUrl}PhoneNumber/`)).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      country_iso: "IN",
      type: "local",
      services: "voice",
      pattern: "80",
      limit: "5",
    });
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("MAAUTHID:token")}`);
  });

  test("buys under the KYC application, naming the number without its +", async () => {
    const { plivo, requests } = plivoAnswering(() =>
      Response.json(
        { status: "fulfilled", numbers: [{ number: "918069000001", status: "Success" }] },
        { status: 201 },
      ),
    );
    expect(await plivo.buyNumber("+918069000001", "compliance-1")).toBe("active");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(`${accountUrl}PhoneNumber/918069000001/`);
    expect(await requests[0]!.json()).toEqual({ compliance_application_id: "compliance-1" });
  });

  test("a purchase Plivo holds back is reported as pending activation", async () => {
    const { plivo } = plivoAnswering(() => Response.json({ status: "pending" }, { status: 201 }));
    expect(await plivo.buyNumber("+918069000001", "compliance-1")).toBe("pending_activation");
  });

  test("Plivo's error message is kept on a refused request", async () => {
    const { plivo } = plivoAnswering(() =>
      Response.json(
        { api_id: "x", error: "compliance application status is 'submitted'" },
        { status: 400 },
      ),
    );
    const error = await plivo.buyNumber("+918069000001", "compliance-1").catch((e) => e);
    expect(error).toBeInstanceOf(PlivoError);
    expect(error).toMatchObject({
      status: 400,
      plivoMessage: "compliance application status is 'submitted'",
    });
  });

  test("connecting points the number at the inbound trunk through app_id", async () => {
    const { plivo, requests } = plivoAnswering(() =>
      Response.json({ message: "changed" }, { status: 202 }),
    );
    await plivo.connectNumber("+918069000001", "trunk-in-1");
    expect(requests[0]!.url).toBe(`${accountUrl}Number/918069000001/`);
    expect(await requests[0]!.json()).toEqual({ app_id: "trunk-in-1" });
  });

  test("whether we hold a number: 200 yes, 404 no", async () => {
    let status = 200;
    const { plivo } = plivoAnswering(() => Response.json({}, { status }));
    expect(await plivo.holdsNumber("+918069000001")).toBe(true);
    status = 404;
    expect(await plivo.holdsNumber("+918069000001")).toBe(false);
  });

  test("releasing a number already gone succeeds; a server error does not", async () => {
    let status = 404;
    const { plivo, requests } = plivoAnswering(() => new Response(null, { status }));
    await plivo.releaseNumber("+918069000001");
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url).toBe(`${accountUrl}Number/918069000001/`);

    status = 500;
    const error = await plivo.releaseNumber("+918069000001").catch((e) => e);
    expect(error).toMatchObject({ status: 500 });
  });

  test("an unreachable Plivo is a PlivoError without a status", async () => {
    const { plivo } = plivoAnswering(() => {
      throw new Error("connection refused");
    });
    const error = await plivo.holdsNumber("+918069000001").catch((e) => e);
    expect(error).toBeInstanceOf(PlivoError);
    expect(error).toMatchObject({ status: null, plivoMessage: "connection refused" });
  });

  test("KYC is submitted as multipart: the application in data, files in document order", async () => {
    const { plivo, requests } = plivoAnswering(() =>
      Response.json({ api_id: "x", compliance_id: "compliance-7" }, { status: 201 }),
    );
    expect(await plivo.submitKyc(application)).toEqual({ applicationId: "compliance-7" });

    expect(requests[0]!.url).toBe(`${accountUrl}PhoneNumber/Compliance/`);
    const form = await requests[0]!.formData();
    expect(JSON.parse(String(form.get("data")))).toEqual({
      country_iso: "IN",
      number_type: "local",
      alias: "automitra:biz-1",
      end_user: {
        type: "business",
        name: "Sharma Dental Clinic Pvt Ltd",
        registration_number: "29ABCDE1234F1Z5",
        address_line1: "12 MG Road",
        city: "Bengaluru",
        state: "Karnataka",
        postal_code: "560001",
        country: "IN",
      },
      documents: [
        {
          document_type_id: "doc-registration-certificate",
          data_fields: { business_name: "Sharma Dental Clinic Pvt Ltd" },
        },
        { document_type_id: "doc-gst-certificate", data_fields: {} },
      ],
      callback_url: "https://voice.example/plivo/kyc",
      callback_method: "POST",
    });
    const first = form.get("documents[0].file") as File;
    const second = form.get("documents[1].file") as File;
    expect([first.name, await first.text()]).toEqual(["incorporation.pdf", "%PDF-1"]);
    expect([second.name, await second.text()]).toEqual(["gst.png", "PNG"]);
  });

  test("a rejected application is resubmitted with PATCH", async () => {
    const { plivo, requests } = plivoAnswering(() => Response.json({ message: "updated" }));
    await plivo.resubmitKyc("compliance-7", application);
    expect(requests[0]!.method).toBe("PATCH");
    expect(requests[0]!.url).toBe(`${accountUrl}PhoneNumber/Compliance/compliance-7`);
  });

  test("an application's state carries Plivo's rejection reason", async () => {
    const { plivo } = plivoAnswering(() =>
      Response.json({
        compliance: {
          compliance_id: "compliance-7",
          status: "rejected",
          rejection_reason: "GST name mismatch",
        },
      }),
    );
    expect(await plivo.kycState("compliance-7")).toEqual({
      status: "rejected",
      rejectionReason: "GST name mismatch",
    });
  });

  test("the Requirements lookup lists document types and their fields", async () => {
    const { plivo, requests } = plivoAnswering(() =>
      Response.json({
        document_types: [
          {
            document_type_id: "doc-gst-certificate",
            name: "GST Certificate",
            description: "Form GST REG-06",
            proof_required: true,
            required_fields: [],
          },
        ],
      }),
    );
    expect(await plivo.kycRequirements("local")).toEqual([
      { documentTypeId: "doc-gst-certificate", name: "GST Certificate", requiredFields: [] },
    ]);
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      country_iso: "IN",
      number_type: "local",
      user_type: "business",
    });
  });
});
