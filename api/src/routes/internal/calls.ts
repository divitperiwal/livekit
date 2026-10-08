import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import {
  appendEventsRequestSchema,
  appendEventsResponseSchema,
  finalizeCallRequestSchema,
  finalizeCallResponseSchema,
  openCallRequestSchema,
  openCallResponseSchema,
} from "../../contracts/internal";
import { HttpError } from "../../http/errors";
import { parseJsonBody } from "../../http/validate";
import { appendEvents } from "../../modules/calls/append-events";
import { finalizeCall } from "../../modules/calls/finalize-call";
import { openCall } from "../../modules/calls/open-call";

const refusalStatus = { not_found: 404, forbidden: 403, invalid: 400 } as const;

export function callRoutes({ db }: AppDependencies) {
  return new Hono()
    .post("/", async (c) => {
      const outcome = await openCall(db, await parseJsonBody(c, openCallRequestSchema));
      if (outcome.kind !== "opened") {
        throw new HttpError(refusalStatus[outcome.kind], outcome.reason);
      }
      return c.json(openCallResponseSchema.parse(outcome.call), 201);
    })
    .post("/:id/events", async (c) => {
      const outcome = await appendEvents(
        db,
        c.req.param("id"),
        await parseJsonBody(c, appendEventsRequestSchema),
      );
      if (outcome.kind !== "appended") {
        throw new HttpError(refusalStatus[outcome.kind], outcome.reason);
      }
      return c.json(appendEventsResponseSchema.parse({ inserted: outcome.inserted }));
    })
    .post("/:id/finalize", async (c) => {
      const outcome = await finalizeCall(
        db,
        c.req.param("id"),
        await parseJsonBody(c, finalizeCallRequestSchema),
      );
      if (outcome.kind !== "finalized") {
        throw new HttpError(refusalStatus[outcome.kind], outcome.reason);
      }
      return c.json(finalizeCallResponseSchema.parse(outcome.call));
    });
}
