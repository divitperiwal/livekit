import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { formFile, parseFormBody } from "../../http/validate";
import {
  findUccComplaint,
  listUccComplaints,
  submitUccProof,
  toPublicUccComplaint,
} from "../../modules/numbers/ucc-complaints";
import { requireNumberServices } from "./numbers";

const proofRefusalStatus = { not_found: 404, refused: 409, invalid_file: 422 } as const;

/**
 * Mounted under /v1/orgs/:externalId/ucc-complaints. Complaints are read from Plivo by a
 * background job; the business answers one with opt-in proof: POST .../:referenceId/proof,
 * multipart, the file as `file` (PDF, JPEG or PNG, 10 MB). It goes straight to Plivo.
 */
export function uccComplaintRoutes({ db, numbers, now }: AppDependencies) {
  return new Hono<V1Env>()
    .get("/", requireScope("orgs:read"), async (c) => {
      const org = c.get("org");
      const complaints = await listUccComplaints(db, org);
      return c.json({
        complaints: complaints.map((complaint) => toPublicUccComplaint(complaint, org)),
      });
    })
    .get("/:referenceId", requireScope("orgs:read"), async (c) => {
      const org = c.get("org");
      const complaint = await findUccComplaint(db, org, c.req.param("referenceId"));
      if (!complaint) throw new HttpError(404, "complaint not found");
      return c.json(toPublicUccComplaint(complaint, org));
    })
    .post("/:referenceId/proof", requireScope("orgs:write"), async (c) => {
      const services = requireNumberServices(numbers);
      const org = c.get("org");
      const file = formFile(await parseFormBody(c), "file");
      const outcome = await submitUccProof(
        { db, plivo: services.plivo, now },
        org,
        c.req.param("referenceId"),
        file,
      );
      if (outcome.kind !== "submitted") {
        const reason = outcome.kind === "not_found" ? "complaint not found" : outcome.reason;
        throw new HttpError(proofRefusalStatus[outcome.kind], reason);
      }
      return c.json(toPublicUccComplaint(outcome.complaint, org), 202);
    });
}
