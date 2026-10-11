import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { parseJsonBody } from "../../http/validate";
import type { NumberServices } from "../../modules/numbers/number-services";
import { listOrgNumbers, pointNumberAtAgent } from "../../modules/numbers/org-numbers";
import { E164 } from "../../modules/numbers/pool";
import { releaseRentedNumber } from "../../modules/numbers/release-number";
import { rentNumber, type RentOutcome } from "../../modules/numbers/rent-number";

const pointSchema = z.strictObject({ agentId: z.string().nullable() });
const rentSchema = z.strictObject({ number: z.string().regex(E164, "must be E.164") });
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

const rentRefusalStatus = {
  kyc_not_accepted: 409,
  no_credit: 402,
  not_offered: 422,
  unavailable: 409,
  key_reused: 422,
  provider_failed: 502,
} as const satisfies Record<Exclude<RentOutcome["kind"], "rented">, number>;

export function requireNumberServices(services: NumberServices | null): NumberServices {
  if (!services) throw new HttpError(503, "renting numbers is not configured");
  return services;
}

/** Mounted under /v1/orgs/:externalId/numbers. */
export function numberRoutes({ db, numbers, now }: AppDependencies) {
  return new Hono<V1Env>()
    .get("/", requireScope("orgs:read"), async (c) =>
      c.json({ numbers: await listOrgNumbers(db, c.get("org").id) }),
    )
    .put("/:number", requireScope("orgs:write"), async (c) => {
      const { agentId } = await parseJsonBody(c, pointSchema);
      const outcome = await pointNumberAtAgent(db, c.get("org").id, c.req.param("number"), agentId);
      if (outcome.kind === "not_found") throw new HttpError(404, outcome.reason);
      return c.json({ number: c.req.param("number"), agentId });
    })
    .post("/", requireScope("numbers:rent"), async (c) => {
      const services = requireNumberServices(numbers);
      const requestKey = c.req.header("idempotency-key");
      if (!requestKey || !IDEMPOTENCY_KEY.test(requestKey)) {
        throw new HttpError(400, "Idempotency-Key header required (1-200 visible characters)");
      }
      const { number } = await parseJsonBody(c, rentSchema);
      const outcome = await rentNumber({ db, numbers: services, now }, c.get("org"), {
        e164: number,
        requestKey,
      });
      if (outcome.kind !== "rented") {
        throw new HttpError(rentRefusalStatus[outcome.kind], outcome.reason);
      }
      return c.json(outcome.number, 201);
    })
    .delete("/:number", requireScope("numbers:rent"), async (c) => {
      const services = requireNumberServices(numbers);
      const e164 = c.req.param("number");
      const outcome = await releaseRentedNumber(
        { db, plivo: services.plivo, now },
        c.get("org").id,
        e164,
      );
      if (outcome.kind === "not_found") throw new HttpError(404, "the org has no such number");
      if (outcome.kind === "managed") {
        throw new HttpError(403, "this number was assigned by us; ask us to release it");
      }
      // Either way the number has stopped answering; a pending release is retried by us.
      const status = outcome.kind === "released" ? "released" : "releasing";
      return c.json({ number: e164, status }, 202);
    });
}
