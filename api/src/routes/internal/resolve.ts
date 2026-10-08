import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { resolveResponseSchema } from "../../contracts/internal";
import { HttpError } from "../../http/errors";
import { parseQuery } from "../../http/validate";
import { resolveCall } from "../../modules/agents/resolve-call";

const resolveQuerySchema = z
  .object({
    agentVersionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    number: z.string().min(1).optional(),
    orgId: z.string().min(1).optional(),
  })
  .refine(
    (query) => query.agentVersionId || query.agentId || query.number,
    "needs agentVersionId, agentId or number",
  );

const refusalStatus = { not_found: 404, forbidden: 403, no_credit: 402 } as const;

export function resolveRoutes(dependencies: AppDependencies) {
  return new Hono().get("/", async (c) => {
    const outcome = await resolveCall(dependencies, parseQuery(c, resolveQuerySchema));
    if (outcome.kind !== "resolved") {
      throw new HttpError(refusalStatus[outcome.kind], outcome.reason);
    }
    return c.json(resolveResponseSchema.parse(outcome.call));
  });
}
