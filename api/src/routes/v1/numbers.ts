import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { parseJsonBody } from "../../http/validate";
import { listOrgNumbers, pointNumberAtAgent } from "../../modules/numbers/org-numbers";

const pointSchema = z.strictObject({ agentId: z.string().nullable() });

/** Mounted under /v1/orgs/:externalId/numbers. Which numbers an org holds is not set here. */
export function numberRoutes({ db }: AppDependencies) {
  return new Hono<V1Env>()
    .get("/", requireScope("orgs:read"), async (c) =>
      c.json({ numbers: await listOrgNumbers(db, c.get("org").id) }),
    )
    .put("/:number", requireScope("orgs:write"), async (c) => {
      const { agentId } = await parseJsonBody(c, pointSchema);
      const outcome = await pointNumberAtAgent(db, c.get("org").id, c.req.param("number"), agentId);
      if (outcome.kind === "not_found") throw new HttpError(404, outcome.reason);
      return c.json({ number: c.req.param("number"), agentId });
    });
}
