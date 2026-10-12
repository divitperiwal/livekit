import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { formFile, formText, parseFormBody } from "../../http/validate";
import {
  businessDetailsSchema,
  KycRequirementsChanged,
  submitNumberKyc,
  type KycDocuments,
} from "../../modules/numbers/number-kyc";
import { kycCallbackUrl } from "../../modules/numbers/number-services";
import type { OrgRow } from "../../modules/orgs/orgs";
import { requireNumberServices } from "./numbers";

const publicKyc = (org: OrgRow) => ({
  status: org.numberKycStatus,
  rejectionReason: org.numberKycRejectionReason,
  updatedAt: org.numberKycUpdatedAt?.toISOString() ?? null,
});

/**
 * Mounted under /v1/orgs/:externalId/number-kyc. PUT is multipart: the business details
 * as fields, `registrationCertificate` and `gstCertificate` as files (PDF, JPEG or PNG,
 * 5 MB each). They go straight to Plivo; only the status is kept.
 */
export function numberKycRoutes({ db, numbers, now }: AppDependencies) {
  return new Hono<V1Env>()
    .get("/", requireScope("orgs:read"), (c) => c.json(publicKyc(c.get("org"))))
    .put("/", requireScope("orgs:write"), async (c) => {
      const services = requireNumberServices(numbers);
      const org = c.get("org");
      const body = await parseFormBody(c);
      const business = businessDetailsSchema.safeParse({
        legalName: formText(body, "legalName"),
        gstin: formText(body, "gstin"),
        addressLine1: formText(body, "addressLine1"),
        addressLine2: formText(body, "addressLine2"),
        city: formText(body, "city"),
        state: formText(body, "state"),
        postalCode: formText(body, "postalCode"),
      });
      if (!business.success) {
        const problems = business.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
        throw new HttpError(400, `invalid body: ${problems.join("; ")}`);
      }
      const documents: KycDocuments = {
        registrationCertificate: formFile(body, "registrationCertificate"),
        gstCertificate: formFile(body, "gstCertificate"),
      };

      const deps = {
        db,
        plivo: services.plivo,
        callbackUrl: kycCallbackUrl(services, org.id),
        now,
      };
      let outcome;
      try {
        outcome = await submitNumberKyc(deps, org, business.data, documents);
      } catch (error) {
        if (!(error instanceof KycRequirementsChanged)) throw error;
        console.error(`ALERT kyc-requirements-changed: ${error.message}`);
        throw new HttpError(503, "number KYC cannot be submitted right now; we have been alerted");
      }
      if (outcome.kind === "refused") throw new HttpError(409, outcome.reason);
      if (outcome.kind === "invalid_document") throw new HttpError(422, outcome.reason);
      return c.json({ status: "submitted", rejectionReason: null }, 202);
    });
}
