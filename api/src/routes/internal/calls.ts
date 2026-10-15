import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import {
  appendEventsRequestSchema,
  appendEventsResponseSchema,
  finalizeCallRequestSchema,
  finalizeCallResponseSchema,
  openCallRequestSchema,
  openCallResponseSchema,
  toolCallRequestSchema,
  toolCallResponseSchema,
} from "../../contracts/internal";
import { HttpError } from "../../http/errors";
import { parseJsonBody } from "../../http/validate";
import { appendEvents } from "../../modules/calls/append-events";
import { finalizeCall } from "../../modules/calls/finalize-call";
import { openCall } from "../../modules/calls/open-call";
import { callTool } from "../../modules/tools/call-tool";

const refusalStatus = { not_found: 404, forbidden: 403, invalid: 400 } as const;
/** 422: the model's arguments do not fit the tool; the worker hands the reason back to it. */
const toolRefusalStatus = { not_found: 404, forbidden: 403, invalid: 422, conflict: 409 } as const;

export function callRoutes(dependencies: AppDependencies) {
  const { db } = dependencies;
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
    })
    .post("/:id/tools", async (c) => {
      const outcome = await callTool(
        dependencies,
        c.req.param("id"),
        await parseJsonBody(c, toolCallRequestSchema),
      );
      if (outcome.kind !== "called") {
        throw new HttpError(toolRefusalStatus[outcome.kind], outcome.reason);
      }
      return c.json(toolCallResponseSchema.parse(outcome.response));
    });
}
