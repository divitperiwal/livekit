import { Hono } from "hono";
import type { Config } from "./config";
import type { Database } from "./db/database";
import { handleError, handleNotFound } from "./http/errors";
import type { CallDispatcher } from "./livekit";
import type { BalanceChecker } from "./modules/billing/balance-check";
import type { RecordingLinker } from "./modules/calls/recording-link";
import type { NumberServices } from "./modules/numbers/number-services";
import type { SecretBox } from "./modules/secrets/secret-box";
import type { ToolSender } from "./modules/tools/call-tool";
import { internalRoutes } from "./routes/internal";
import { plivoRoutes } from "./routes/plivo";
import { v1Routes } from "./routes/v1";

export type AppDependencies = {
  db: Database;
  config: Pick<Config, "INTERNAL_API_SECRET">;
  balanceChecker: BalanceChecker;
  secretBox: SecretBox;
  /** Null when outbound calling is not configured: placing a call answers 503. */
  dispatcher: CallDispatcher | null;
  /** Null when Plivo is not configured: renting, releasing and KYC answer 503. */
  numbers: NumberServices | null;
  /** Null when recording storage is not configured: recording links answer 503. */
  recordingLinker: RecordingLinker | null;
  roomPrefix: string;
  /** Requests per API key per minute. */
  ratePerMinute: number;
  /** Default: customer tool requests go out through the SSRF guard. */
  sendToolRequest?: ToolSender;
  /** [0, 1); decides the candidate split. Injected so tests can fix it. */
  random?: () => number;
  now?: () => Date;
};

export function createApp(dependencies: AppDependencies) {
  const app = new Hono();
  app.route("/internal", internalRoutes(dependencies));
  app.route("/v1", v1Routes(dependencies));
  app.route("/plivo", plivoRoutes(dependencies));
  app.onError(handleError);
  app.notFound(handleNotFound);
  return app;
}
