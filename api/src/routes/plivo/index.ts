import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import { orgs } from "../../db/schema";
import { HttpError } from "../../http/errors";
import { isUuid } from "../../modules/ids";
import { refreshNumberKyc } from "../../modules/numbers/number-kyc";
import { isKycCallbackToken, kycCallbackUrl } from "../../modules/numbers/number-services";

/**
 * Plivo's callbacks, reached from outside through Caddy. The KYC callback's body is not
 * documented, so it is never read: the org's status is read back from Plivo instead.
 */
export function plivoRoutes({ db, numbers, now }: AppDependencies) {
  return new Hono().post("/kyc/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    const token = c.req.query("token") ?? "";
    const known =
      numbers !== null && isUuid(orgId) && isKycCallbackToken(numbers.callbackSecret, orgId, token);
    if (!known) throw new HttpError(404, "not found");

    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    if (!org) throw new HttpError(404, "not found");
    const deps = { db, plivo: numbers.plivo, callbackUrl: kycCallbackUrl(numbers, org.id), now };
    const { status } = await refreshNumberKyc(deps, org);
    return c.json({ status });
  });
}
