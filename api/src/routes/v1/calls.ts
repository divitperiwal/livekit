import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { parseJsonBody, parseQuery } from "../../http/validate";
import { placeCall, placeCallInputSchema } from "../../modules/calls/place-call";
import { getCall, listCalls } from "../../modules/calls/read-calls";

const listSchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  disposition: z.string().optional(),
});

const refusalStatus = {
  not_found: 404,
  rejected: 422,
  no_credit: 402,
  concurrency_limit: 429,
  unavailable: 503,
} as const;

/** Mounted under /v1/orgs/:externalId/calls. */
export function v1CallRoutes(dependencies: AppDependencies) {
  const { db } = dependencies;
  return new Hono<V1Env>()
    .post("/", requireScope("calls:write"), async (c) => {
      const org = c.get("org");
      const outcome = await placeCall(
        dependencies,
        { org, apiKeyId: c.get("apiKey").keyId },
        await parseJsonBody(c, placeCallInputSchema),
      );
      if (outcome.kind !== "queued") {
        throw new HttpError(refusalStatus[outcome.kind], outcome.reason);
      }
      return c.json(await getCall(db, org, outcome.callId), 202);
    })
    .get("/", requireScope("calls:read"), async (c) => {
      const result = await listCalls(db, c.get("org"), parseQuery(c, listSchema));
      if ("invalidCursor" in result) {
        throw new HttpError(400, "before: not a cursor this API returned");
      }
      return c.json(result);
    })
    .get("/:callId", requireScope("calls:read"), async (c) => {
      const call = await getCall(db, c.get("org"), c.req.param("callId"));
      if (!call) throw new HttpError(404, "call not found");
      return c.json(call);
    });
}
