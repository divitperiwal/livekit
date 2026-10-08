import { Hono } from "hono";
import type { AppDependencies } from "../../app";
import { requireInternalSecret } from "../../http/internal-secret";
import { callRoutes } from "./calls";
import { resolveRoutes } from "./resolve";

/** Worker-only routes. Never exposed by Caddy; the secret guards them anyway. */
export function internalRoutes(dependencies: AppDependencies) {
  const routes = new Hono();
  routes.use("*", requireInternalSecret(dependencies.config.INTERNAL_API_SECRET));
  routes.route("/resolve", resolveRoutes(dependencies));
  routes.route("/calls", callRoutes(dependencies));
  return routes;
}
