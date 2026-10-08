import { Hono } from "hono";
import type { Config } from "./config";
import type { Database } from "./db/database";
import { handleError, handleNotFound } from "./http/errors";
import type { CallDispatcher } from "./livekit";
import type { BalanceChecker } from "./modules/billing/balance-check";
import type { SecretBox } from "./modules/secrets/secret-box";
import { internalRoutes } from "./routes/internal";
import { v1Routes } from "./routes/v1";

export type AppDependencies = {
  db: Database;
  config: Pick<Config, "INTERNAL_API_SECRET">;
  balanceChecker: BalanceChecker;
  secretBox: SecretBox;
  /** Null when outbound calling is not configured: placing a call answers 503. */
  dispatcher: CallDispatcher | null;
  roomPrefix: string;
  /** Requests per API key per minute. */
  ratePerMinute: number;
  /** [0, 1); decides the candidate split. Injected so tests can fix it. */
  random?: () => number;
  now?: () => Date;
};

export function createApp(dependencies: AppDependencies) {
  const app = new Hono();
  app.route("/internal", internalRoutes(dependencies));
  app.route("/v1", v1Routes(dependencies));
  app.onError(handleError);
  app.notFound(handleNotFound);
  return app;
}
