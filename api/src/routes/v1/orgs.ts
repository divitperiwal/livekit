import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { requireOrg, requireScope, type V1Env } from "../../http/v1-auth";
import { parseJsonBody, parseQuery } from "../../http/validate";
import {
  deleteOrg,
  EXTERNAL_ID,
  listOrgs,
  orgInputSchema,
  toPublicOrg,
  upsertOrg,
} from "../../modules/orgs/orgs";

const pageSchema = z.object({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function orgRoutes({ db }: AppDependencies) {
  return new Hono<V1Env>()
    .get("/", requireScope("orgs:read"), async (c) => {
      const page = parseQuery(c, pageSchema);
      const rows = await listOrgs(db, c.get("apiKey").accountId, page);
      return c.json({
        orgs: rows.map(toPublicOrg),
        nextAfter: rows.length === page.limit ? rows.at(-1)!.externalId : null,
      });
    })
    .put("/:externalId", requireScope("orgs:write"), async (c) => {
      const externalId = c.req.param("externalId");
      if (!EXTERNAL_ID.test(externalId)) {
        throw new HttpError(400, "org id: 1-100 characters of letters, digits and . _ : -");
      }
      const outcome = await upsertOrg(
        db,
        c.get("apiKey").accountId,
        externalId,
        await parseJsonBody(c, orgInputSchema),
      );
      if (outcome.kind === "deleted") {
        throw new HttpError(409, "this org was deleted; use a new id");
      }
      return c.json(toPublicOrg(outcome.org), outcome.kind === "created" ? 201 : 200);
    })
    .get("/:externalId", requireScope("orgs:read"), requireOrg(db), (c) =>
      c.json(toPublicOrg(c.get("org"))),
    )
    .delete("/:externalId", requireScope("orgs:write"), requireOrg(db), async (c) => {
      await deleteOrg(db, c.get("org").id);
      return c.body(null, 204);
    });
}
