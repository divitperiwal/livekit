import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { INTERNAL_SECRET_HEADER } from "../contracts/internal";
import { HttpError } from "./errors";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Guarantee 6. Compares digests in constant time, so neither the secret's content nor
 * its length leaks through response timing.
 */
export function requireInternalSecret(secret: string): MiddlewareHandler {
  const expected = digest(secret);
  return async (c, next) => {
    const given = c.req.header(INTERNAL_SECRET_HEADER);
    if (given === undefined || !timingSafeEqual(digest(given), expected)) {
      throw new HttpError(401, "missing or wrong internal secret");
    }
    await next();
  };
}
