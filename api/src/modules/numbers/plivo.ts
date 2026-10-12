import { z } from "zod";
import { errorMessage } from "../../error-message";

export const PLIVO_API_BASE = "https://api.plivo.com/v1";
export const PLIVO_TIMEOUT_MS = 10_000;
/** A KYC submission carries two documents of up to 5 MB each; opt-in proof one of up to 10 MB. */
export const PLIVO_UPLOAD_TIMEOUT_MS = 60_000;
/** Plivo's page size for complaints. */
const UCC_PAGE_SIZE = 20;
/** Plivo's Compliance API covers India only, and we rent only Indian numbers. */
const COUNTRY_ISO = "IN";

export type PlivoCredentials = { authId: string; authToken: string };

export const plivoNumberTypes = ["local", "mobile", "tollfree"] as const;
export type PlivoNumberType = (typeof plivoNumberTypes)[number];

export type NumberSearch = {
  numberType: PlivoNumberType;
  /** Digits the number must contain, e.g. "80" for Bengaluru landlines. */
  pattern?: string;
  city?: string;
  limit?: number;
};

export type AvailableNumber = {
  e164: string;
  numberType: string;
  city: string | null;
  region: string | null;
  smsEnabled: boolean;
};

/** `pending_activation`: Plivo still holds the number back until documents are checked. */
export type PurchaseOutcome = "active" | "pending_activation";

export const plivoKycStatuses = [
  "draft",
  "submitted",
  "accepted",
  "rejected",
  "suspended",
  "expired",
] as const;
export type PlivoKycStatus = (typeof plivoKycStatuses)[number];
export type KycState = { status: PlivoKycStatus; rejectionReason: string | null };

export type KycDocumentType = {
  documentTypeId: string;
  name: string;
  requiredFields: { fieldName: string; required: boolean }[];
};

export type PlivoFile = { fileName: string; content: Blob };

export type KycApplication = {
  /** Shown in Plivo's console; we use the org's id so a person can find it there. */
  alias: string;
  numberType: PlivoNumberType;
  callbackUrl: string | null;
  business: {
    name: string;
    registrationNumber: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postalCode: string;
  };
  documents: { documentTypeId: string; dataFields: Record<string, string>; file: PlivoFile }[];
};

export const uccComplaintStatuses = ["pending", "in_review", "accepted", "rejected"] as const;
export type UccComplaintStatus = (typeof uccComplaintStatuses)[number];

/** A recipient's unsolicited-call (UCC) complaint about a call from one of our numbers. */
export type UccComplaint = {
  /** PUCC-YYYY-NNNNNNNNN */
  referenceId: string;
  status: UccComplaintStatus;
  /** Our number that placed the call. */
  fromNumber: string;
  complainantNumber: string;
  /** The day of the call, YYYY-MM-DD. */
  calledOn: string;
  category: string | null;
  callUuid: string | null;
  rejectionReason: string | null;
  reportedAt: Date;
  updatedAt: Date;
};

/** Everything voiceAi asks of Plivo. Tests use `test/fixtures/fake-plivo.ts`. */
export type Plivo = {
  searchNumbers(search: NumberSearch): Promise<AvailableNumber[]>;
  /** Buys under an accepted KYC application. */
  buyNumber(e164: string, complianceApplicationId: string): Promise<PurchaseOutcome>;
  /** Sends the number's calls to our inbound SIP trunk. Safe to repeat. */
  connectNumber(e164: string, inboundTrunkId: string): Promise<void>;
  /** Whether our account holds the number: settles a rent that stopped between buying and saving. */
  holdsNumber(e164: string): Promise<boolean>;
  /** Gives the number back to Plivo. A number we no longer hold counts as released. */
  releaseNumber(e164: string): Promise<void>;
  kycRequirements(numberType: PlivoNumberType): Promise<KycDocumentType[]>;
  submitKyc(application: KycApplication): Promise<{ applicationId: string }>;
  /** Replaces every document of a rejected application and submits it again. */
  resubmitKyc(applicationId: string, application: KycApplication): Promise<void>;
  kycState(applicationId: string): Promise<KycState>;
  /** Puts numbers we hold under an accepted application: a managed number given to a business, or its numbers after a new application. */
  linkNumbers(applicationId: string, e164s: string[]): Promise<void>;
  /** Every complaint against our account reported since then, newest first. */
  uccComplaints(reportedSince: Date): Promise<UccComplaint[]>;
  /** Opt-in proof for a pending or rejected complaint (PDF, PNG or JPEG, 10 MB); it moves to in_review. */
  submitUccProof(referenceId: string, file: PlivoFile): Promise<void>;
};

export class PlivoError extends Error {
  constructor(
    readonly status: number | null,
    readonly plivoMessage: string,
  ) {
    super(status === null ? `Plivo: ${plivoMessage}` : `Plivo HTTP ${status}: ${plivoMessage}`);
    this.name = "PlivoError";
  }
}

const searchResponseSchema = z.object({
  objects: z.array(
    z.object({
      number: z.string(),
      type: z.string(),
      city: z.string().nullish(),
      region: z.string().nullish(),
      sms_enabled: z.boolean().nullish(),
    }),
  ),
});
const purchaseResponseSchema = z.object({
  status: z.string(),
  numbers: z.array(z.object({ number: z.string(), status: z.string() })).optional(),
});
const requirementsResponseSchema = z.object({
  document_types: z.array(
    z.object({
      document_type_id: z.string(),
      name: z.string(),
      required_fields: z.array(z.object({ field_name: z.string(), required: z.boolean() })),
    }),
  ),
});
const createdApplicationSchema = z.object({ compliance_id: z.string() });
const applicationResponseSchema = z.object({
  compliance: z.object({
    status: z.enum(plivoKycStatuses),
    rejection_reason: z.string().nullish(),
  }),
});
const linkResponseSchema = z.object({
  report: z.array(
    z.object({ number: z.string(), status: z.string(), remarks: z.string().nullish() }),
  ),
});
/** ISO 8601 in Plivo's documentation; read leniently, since a parse failure stops the poll. */
const plivoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "not a timestamp",
});
const uccComplaintSchema = z.object({
  reference_id: z.string(),
  status: z.enum(uccComplaintStatuses),
  from_number: z.string(),
  to_number: z.string(),
  initiation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "not a date"),
  complaint_category: z.string().nullish(),
  call_uuid: z.string().nullish(),
  rejection_reason: z.string().nullish(),
  created_at: plivoTimestamp,
  updated_at: plivoTimestamp,
});
const uccPageSchema = z.object({
  meta: z.object({ next: z.string().nullish() }),
  objects: z.array(uccComplaintSchema),
});
const errorBodySchema = z.object({ error: z.unknown() });

type PlivoRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: Record<string, unknown>;
  form?: FormData;
  timeoutMs?: number;
};
type PlivoResponse = { status: number; body: unknown };

export type PlivoDependencies = { fetch?: typeof fetch };

export function plivoClient(
  credentials: PlivoCredentials,
  dependencies: PlivoDependencies = {},
): Plivo {
  const send = plivoSender(credentials, dependencies.fetch ?? fetch);

  return {
    async searchNumbers(search) {
      const { body } = await sendExpecting(send, [200], {
        method: "GET",
        path: "PhoneNumber/",
        query: {
          country_iso: COUNTRY_ISO,
          type: search.numberType,
          services: "voice",
          pattern: search.pattern,
          city: search.city,
          limit: search.limit,
        },
      });
      return searchResponseSchema.parse(body).objects.map((found) => ({
        e164: `+${found.number}`,
        numberType: found.type,
        city: found.city ?? null,
        region: found.region ?? null,
        smsEnabled: found.sms_enabled ?? false,
      }));
    },

    async buyNumber(e164, complianceApplicationId) {
      const { body } = await sendExpecting(send, [200, 201], {
        method: "POST",
        path: `PhoneNumber/${plivoNumber(e164)}/`,
        json: { compliance_application_id: complianceApplicationId },
      });
      return purchaseOutcome(purchaseResponseSchema.parse(body));
    },

    async connectNumber(e164, inboundTrunkId) {
      await sendExpecting(send, [200, 202], {
        method: "POST",
        path: `Number/${plivoNumber(e164)}/`,
        json: { app_id: inboundTrunkId },
      });
    },

    async holdsNumber(e164) {
      const { status } = await sendExpecting(send, [200, 404], {
        method: "GET",
        path: `Number/${plivoNumber(e164)}/`,
      });
      return status === 200;
    },

    async releaseNumber(e164) {
      await sendExpecting(send, [204, 404], {
        method: "DELETE",
        path: `Number/${plivoNumber(e164)}/`,
      });
    },

    async kycRequirements(numberType) {
      const { body } = await sendExpecting(send, [200], {
        method: "GET",
        path: "PhoneNumber/Compliance/Requirements",
        query: { country_iso: COUNTRY_ISO, number_type: numberType, user_type: "business" },
      });
      return requirementsResponseSchema.parse(body).document_types.map((documentType) => ({
        documentTypeId: documentType.document_type_id,
        name: documentType.name,
        requiredFields: documentType.required_fields.map((field) => ({
          fieldName: field.field_name,
          required: field.required,
        })),
      }));
    },

    async submitKyc(application) {
      const { body } = await sendExpecting(send, [200, 201], {
        method: "POST",
        path: "PhoneNumber/Compliance/",
        form: kycForm(application),
        timeoutMs: PLIVO_UPLOAD_TIMEOUT_MS,
      });
      return { applicationId: createdApplicationSchema.parse(body).compliance_id };
    },

    async resubmitKyc(applicationId, application) {
      await sendExpecting(send, [200], {
        method: "PATCH",
        path: `PhoneNumber/Compliance/${applicationId}`,
        form: kycForm(application),
        timeoutMs: PLIVO_UPLOAD_TIMEOUT_MS,
      });
    },

    async kycState(applicationId) {
      const { body } = await sendExpecting(send, [200], {
        method: "GET",
        path: `PhoneNumber/Compliance/${applicationId}`,
      });
      const { compliance } = applicationResponseSchema.parse(body);
      return { status: compliance.status, rejectionReason: compliance.rejection_reason ?? null };
    },

    async linkNumbers(applicationId, e164s) {
      const { body } = await sendExpecting(send, [200], {
        method: "POST",
        path: "PhoneNumber/Compliance/Link/",
        json: {
          numbers: e164s.map((number) => ({ number, compliance_application_id: applicationId })),
        },
      });
      const failed = linkResponseSchema
        .parse(body)
        .report.filter((entry) => entry.status !== "success");
      if (failed.length > 0) {
        const reasons = failed.map((entry) => `${entry.number}: ${entry.remarks ?? entry.status}`);
        throw new PlivoError(null, `could not link ${reasons.join("; ")}`);
      }
    },

    async uccComplaints(reportedSince) {
      const complaints: UccComplaint[] = [];
      for (let offset = 0; ; offset += UCC_PAGE_SIZE) {
        const { body } = await sendExpecting(send, [200], {
          method: "GET",
          path: "Ucc/",
          query: {
            created_at__gte: plivoDateTime(reportedSince),
            limit: UCC_PAGE_SIZE,
            offset,
          },
        });
        const page = uccPageSchema.parse(body);
        complaints.push(...page.objects.map(toUccComplaint));
        if (!page.meta.next || page.objects.length < UCC_PAGE_SIZE) return complaints;
      }
    },

    async submitUccProof(referenceId, file) {
      const form = new FormData();
      form.append("file", file.content, file.fileName);
      await sendExpecting(send, [200, 201], {
        method: "POST",
        path: `Ucc/${encodeURIComponent(referenceId)}/`,
        form,
        timeoutMs: PLIVO_UPLOAD_TIMEOUT_MS,
      });
    },
  };
}

function toUccComplaint(complaint: z.output<typeof uccComplaintSchema>): UccComplaint {
  return {
    referenceId: complaint.reference_id,
    status: complaint.status,
    fromNumber: e164(complaint.from_number),
    complainantNumber: e164(complaint.to_number),
    calledOn: complaint.initiation_date.slice(0, 10),
    category: complaint.complaint_category ?? null,
    callUuid: complaint.call_uuid || null,
    rejectionReason: complaint.rejection_reason || null,
    reportedAt: new Date(complaint.created_at),
    updatedAt: new Date(complaint.updated_at),
  };
}

/** Plivo's filters take "YYYY-MM-DD HH:MM:ss" in UTC. */
function plivoDateTime(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

/** Plivo writes numbers with or without the leading "+". */
function e164(number: string): string {
  return number.startsWith("+") ? number : `+${number}`;
}

/** Plivo names numbers by their digits, without the leading "+". */
function plivoNumber(e164: string): string {
  return e164.replace(/^\+/, "");
}

function purchaseOutcome(purchase: z.output<typeof purchaseResponseSchema>): PurchaseOutcome {
  const failed = purchase.numbers?.find((number) => number.status.toLowerCase() !== "success");
  if (failed) throw new PlivoError(null, `purchase of ${failed.number} ended "${failed.status}"`);
  if (purchase.status === "fulfilled") return "active";
  if (purchase.status === "pending") return "pending_activation";
  throw new PlivoError(null, `unexpected purchase status "${purchase.status}"`);
}

/** Multipart: the application as JSON in `data`, each file as `documents[i].file` in the same order. */
function kycForm(application: KycApplication): FormData {
  const { business } = application;
  const data = {
    country_iso: COUNTRY_ISO,
    number_type: application.numberType,
    alias: application.alias,
    end_user: {
      type: "business",
      name: business.name,
      registration_number: business.registrationNumber,
      address_line1: business.addressLine1,
      address_line2: business.addressLine2,
      city: business.city,
      state: business.state,
      postal_code: business.postalCode,
      country: COUNTRY_ISO,
    },
    documents: application.documents.map((document) => ({
      document_type_id: document.documentTypeId,
      data_fields: document.dataFields,
    })),
    ...(application.callbackUrl === null
      ? {}
      : { callback_url: application.callbackUrl, callback_method: "POST" }),
  };
  const form = new FormData();
  form.append("data", JSON.stringify(data));
  for (const [index, document] of application.documents.entries()) {
    form.append(`documents[${index}].file`, document.file.content, document.file.fileName);
  }
  return form;
}

async function sendExpecting(
  send: (request: PlivoRequest) => Promise<PlivoResponse>,
  expectedStatuses: number[],
  request: PlivoRequest,
): Promise<PlivoResponse> {
  const response = await send(request);
  if (!expectedStatuses.includes(response.status)) {
    throw new PlivoError(response.status, plivoErrorMessage(response.body));
  }
  return response;
}

function plivoErrorMessage(body: unknown): string {
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return "no error message";
  const { error } = parsed.data;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function plivoSender(credentials: PlivoCredentials, fetchImpl: typeof fetch) {
  const accountUrl = `${PLIVO_API_BASE}/Account/${credentials.authId}/`;
  const authorization = `Basic ${btoa(`${credentials.authId}:${credentials.authToken}`)}`;

  return async (request: PlivoRequest): Promise<PlivoResponse> => {
    const url = new URL(request.path, accountUrl);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { authorization };
    if (request.json) headers["content-type"] = "application/json";
    const body = request.form ?? (request.json ? JSON.stringify(request.json) : undefined);

    const timeoutMs = request.timeoutMs ?? PLIVO_TIMEOUT_MS;
    // An explicit timer: Bun's AbortSignal.timeout does not fire while the loop is otherwise idle.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`no answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(url, {
        method: request.method,
        headers,
        body,
        signal: controller.signal,
      });
      return { status: response.status, body: await readBody(response) };
    } catch (error) {
      throw new PlivoError(null, errorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}
