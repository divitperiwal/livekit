import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import { FixedWindowRateLimiter } from "../../http/rate-limit";
import { requireApiKey, requireOrg, type V1Env } from "../../http/v1-auth";
import { agentRoutes } from "./agents";
import { v1CallRoutes } from "./calls";
import { numberRoutes } from "./numbers";
import { orgRoutes } from "./orgs";

/** The public API: an API key on every request; everything under an org is scoped to the key's account. */
export function v1Routes(dependencies: AppDependencies) {
  const limiter = new FixedWindowRateLimiter(dependencies.ratePerMinute);
  const routes = new Hono<V1Env>();
  routes.use("*", requireApiKey(dependencies.db, limiter));
  // First: `PUT /orgs/:externalId` creates the org, so it must answer before the org lookup
  // below, whose pattern also matches `/orgs/:externalId` itself.
  routes.route("/orgs", orgRoutes(dependencies));
  routes.use("/orgs/:externalId/*", requireOrg(dependencies.db));
  routes.route("/orgs/:externalId/agents", agentRoutes(dependencies));
  routes.route("/orgs/:externalId/numbers", numberRoutes(dependencies));
  routes.route("/orgs/:externalId/calls", v1CallRoutes(dependencies));
  return routes;
}
