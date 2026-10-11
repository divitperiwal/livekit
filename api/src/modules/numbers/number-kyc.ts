import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/database";
import { orgs, phoneNumbers, type numberKycStatus } from "../../db/schema";
import type { OrgRow } from "../orgs/orgs";
import { enqueueWebhook } from "../webhooks/enqueue";
import type {
  KycApplication,
  KycDocumentType,
  KycFile,
  Plivo,
  PlivoKycStatus,
  PlivoNumberType,
} from "./plivo";

/** We rent landlines (080, 022, ...); Plivo's application is per number type. */
export const RENTED_NUMBER_TYPE: PlivoNumberType = "local";
export const KYC_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const KYC_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const businessDetailsSchema = z.strictObject({
  legalName: z.string().trim().min(1).max(255),
  gstin: z.string().regex(GSTIN, "must be a 15-character GSTIN"),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postalCode: z.string().regex(/^\d{6}$/, "must be a 6-digit PIN code"),
});
export type BusinessDetails = z.infer<typeof businessDetailsSchema>;

/** A Certificate of Incorporation (or Udyam) and a GST certificate (Form GST REG-06). */
export type KycDocuments = { registrationCertificate: KycFile; gstCertificate: KycFile };

export type NumberKycStatus = (typeof numberKycStatus.enumValues)[number];
export type NumberKycDependencies = {
  db: Database;
  plivo: Plivo;
  /** Where Plivo posts its decision; null until that route exists, and the poll covers it. */
  callbackUrl: string | null;
  now?: () => Date;
};

/** Plivo's Requirements no longer match what we send; a person must look before we submit again. */
export class KycRequirementsChanged extends Error {}

export type SubmitKycOutcome =
  | { kind: "submitted"; applicationId: string }
  /** The org's KYC is under review, accepted or suspended. */
  | { kind: "refused"; reason: string }
  | { kind: "invalid_document"; reason: string };

/**
 * Sends the business's documents to Plivo: a new application the first time or after one
 * expired, a resubmission after a rejection. Only the status is kept, never the files.
 */
export async function submitNumberKyc(
  deps: NumberKycDependencies,
  org: OrgRow,
  business: BusinessDetails,
  documents: KycDocuments,
): Promise<SubmitKycOutcome> {
  const refusal = submissionRefusal(org.numberKycStatus);
  if (refusal) return { kind: "refused", reason: refusal };
  const badDocument = invalidDocument(documents);
  if (badDocument) return { kind: "invalid_document", reason: badDocument };

  const documentTypes = await deps.plivo.kycRequirements(RENTED_NUMBER_TYPE);
  const application = kycApplication(deps, org, business, documents, documentTypes);
  const applicationId = await sendApplication(deps.plivo, org, application);
  await recordKycState(deps, org, { status: "submitted", applicationId, rejectionReason: null });
  return { kind: "submitted", applicationId };
}

export type RefreshKycOutcome = { status: NumberKycStatus; changed: boolean };

/**
 * Reads the application's status from Plivo and stores it, telling the account when it
 * changed. Plivo's callbacks cover only accepted and rejected, so this also runs on a timer.
 * On acceptance, numbers the org already holds move under the new application (the
 * expired case: Plivo asks for a new application linked to the existing numbers).
 */
export async function refreshNumberKyc(
  deps: NumberKycDependencies,
  org: OrgRow,
): Promise<RefreshKycOutcome> {
  if (org.numberKycStatus === "none") return { status: "none", changed: false };
  const applicationId = requireApplicationId(org);
  const state = await deps.plivo.kycState(applicationId);
  const status = toNumberKycStatus(state.status);
  const rejectionReason =
    status === "rejected" ? (state.rejectionReason ?? "no reason given") : null;
  const unchanged =
    status === org.numberKycStatus && rejectionReason === org.numberKycRejectionReason;
  if (unchanged) return { status, changed: false };

  if (status === "accepted") await linkHeldNumbers(deps, org, applicationId);
  await recordKycState(deps, org, { status, applicationId, rejectionReason });
  return { status, changed: true };
}

function submissionRefusal(status: NumberKycStatus): string | null {
  switch (status) {
    case "submitted":
      return "KYC is already with Plivo for review";
    case "accepted":
      return "KYC is already accepted";
    case "suspended":
      return "KYC is suspended over spam complaints; Plivo lifts it on consent proof, not new documents";
    default:
      return null;
  }
}

function invalidDocument(documents: KycDocuments): string | null {
  for (const [name, file] of Object.entries(documents)) {
    if (!(KYC_FILE_TYPES as readonly string[]).includes(file.content.type)) {
      return `${name} must be a PDF, JPEG or PNG`;
    }
    if (file.content.size > KYC_FILE_MAX_BYTES) return `${name} must be 5 MB or less`;
  }
  return null;
}

function kycApplication(
  deps: NumberKycDependencies,
  org: OrgRow,
  business: BusinessDetails,
  documents: KycDocuments,
  documentTypes: KycDocumentType[],
): KycApplication {
  const registration = documentType(documentTypes, /registration|incorporation/i);
  const gst = documentType(documentTypes, /gst/i);
  return {
    alias: org.id,
    numberType: RENTED_NUMBER_TYPE,
    callbackUrl: deps.callbackUrl,
    business: {
      name: business.legalName,
      registrationNumber: business.gstin,
      addressLine1: business.addressLine1,
      addressLine2: business.addressLine2,
      city: business.city,
      state: business.state,
      postalCode: business.postalCode,
    },
    documents: [
      {
        documentTypeId: registration.documentTypeId,
        dataFields: dataFields(registration, business),
        file: documents.registrationCertificate,
      },
      {
        documentTypeId: gst.documentTypeId,
        dataFields: dataFields(gst, business),
        file: documents.gstCertificate,
      },
    ],
  };
}

function documentType(documentTypes: KycDocumentType[], name: RegExp): KycDocumentType {
  const found = documentTypes.find((candidate) => name.test(candidate.name));
  if (!found) {
    const offered = documentTypes.map((candidate) => candidate.name).join(", ");
    throw new KycRequirementsChanged(
      `Plivo lists no document matching ${name} (it lists ${offered})`,
    );
  }
  return found;
}

/** The fields Plivo requires on a document. Only the legal name is known; anything new stops us. */
function dataFields(documentType: KycDocumentType, business: BusinessDetails) {
  const fields: Record<string, string> = {};
  for (const field of documentType.requiredFields.filter((candidate) => candidate.required)) {
    if (field.fieldName !== "business_name") {
      throw new KycRequirementsChanged(
        `Plivo now requires "${field.fieldName}" on ${documentType.name}`,
      );
    }
    fields.business_name = business.legalName;
  }
  return fields;
}

async function sendApplication(plivo: Plivo, org: OrgRow, application: KycApplication) {
  if (org.numberKycStatus !== "rejected") {
    return (await plivo.submitKyc(application)).applicationId;
  }
  const applicationId = requireApplicationId(org);
  await plivo.resubmitKyc(applicationId, application);
  return applicationId;
}

function toNumberKycStatus(status: PlivoKycStatus): NumberKycStatus {
  return status === "draft" ? "submitted" : status;
}

function requireApplicationId(org: OrgRow): string {
  if (org.numberKycApplicationId === null) {
    throw new Error(`org ${org.id} has KYC status ${org.numberKycStatus} but no application`);
  }
  return org.numberKycApplicationId;
}

async function linkHeldNumbers(deps: NumberKycDependencies, org: OrgRow, applicationId: string) {
  const held = await deps.db
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.orgId, org.id), eq(phoneNumbers.status, "assigned")));
  if (held.length === 0) return;
  await deps.plivo.linkNumbers(
    applicationId,
    held.map((number) => number.e164),
  );
}

type KycState = {
  status: NumberKycStatus;
  applicationId: string;
  rejectionReason: string | null;
};

async function recordKycState(deps: NumberKycDependencies, org: OrgRow, state: KycState) {
  const now = deps.now?.() ?? new Date();
  await deps.db.transaction(async (tx) => {
    await tx
      .update(orgs)
      .set({
        numberKycStatus: state.status,
        numberKycApplicationId: state.applicationId,
        numberKycRejectionReason: state.rejectionReason,
        numberKycUpdatedAt: now,
      })
      .where(eq(orgs.id, org.id));
    await enqueueWebhook(tx, {
      accountId: org.accountId,
      orgId: org.id,
      type: "number_kyc.updated",
      // Each change is its own event: the same status can come back (accepted, suspended, accepted).
      key: `${org.id}:${crypto.randomUUID()}`,
      payload: {
        orgId: org.externalId,
        status: state.status,
        rejectionReason: state.rejectionReason,
      },
    });
  });
}
