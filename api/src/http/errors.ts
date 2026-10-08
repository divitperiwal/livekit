import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** A refusal with a status and a message the caller may see. Every error body is `{ error }`. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

export function handleError(error: Error, c: Context) {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  console.error("unhandled error", c.req.method, c.req.path, error);
  return c.json({ error: "internal error" }, 500);
}

export function handleNotFound(c: Context) {
  return c.json({ error: "not found" }, 404);
}
