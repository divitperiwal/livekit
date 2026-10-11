import { Hono } from "hono";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { HttpError } from "../../http/errors";
import { FixedWindowRateLimiter } from "../../http/rate-limit";
import { requireScope, type V1Env } from "../../http/v1-auth";
import { parseQuery } from "../../http/validate";
import { RENTED_NUMBER_TYPE } from "../../modules/numbers/number-kyc";
import { findRentableNumbers } from "../../modules/numbers/rent-number";
import { requireNumberServices } from "./numbers";

/** Every search is a call to Plivo, so it has its own, lower limit per key. */
export const NUMBER_SEARCHES_PER_MINUTE = 10;

const searchSchema = z.object({
  pattern: z
    .string()
    .regex(/^\d{1,10}$/, "digits only")
    .optional(),
  city: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

/** Mounted under /v1/numbers. */
export function availableNumberRoutes({ db, numbers, now }: AppDependencies) {
  const searches = new FixedWindowRateLimiter(NUMBER_SEARCHES_PER_MINUTE);
  return new Hono<V1Env>().get("/available", requireScope("numbers:rent"), async (c) => {
    const services = requireNumberServices(numbers);
    const retryAfter = searches.take(c.get("apiKey").keyId);
    if (retryAfter !== null) {
      c.header("retry-after", String(retryAfter));
      throw new HttpError(
        429,
        `number search is limited to ${NUMBER_SEARCHES_PER_MINUTE} a minute`,
      );
    }
    const query = parseQuery(c, searchSchema);
    const result = await findRentableNumbers(
      { db, numbers: services, now },
      c.get("apiKey").accountId,
      { numberType: RENTED_NUMBER_TYPE, ...query },
    );
    if (result.kind === "not_offered") throw new HttpError(422, result.reason);
    return c.json({ numbers: result.numbers });
  });
}
