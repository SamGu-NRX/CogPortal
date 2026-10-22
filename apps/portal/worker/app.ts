import { Hono } from "hono";
import type { AppEnv } from "./env";
import { validateServerEnv } from "./env";
import { errorResponse, handleError } from "./http/errors";
import { registerBenchmarkRoutes } from "./routes/benchmarks";
import { registerCohortRoutes } from "./routes/cohorts";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerGithubRoutes } from "./routes/github";
import { registerLeaderboardRoutes } from "./routes/leaderboard";
import { registerRunRoutes } from "./routes/runs";
import { registerSessionRoutes } from "./routes/session";
import { registerTeamRoutes } from "./routes/team";
import { registerTeamMembershipRoutes } from "./routes/team-membership";
import { registerConnectionRoutes } from "./routes/connections";
import { registerLocalReportRoutes } from "./routes/local-reports";
import { registerLocalRunRoutes } from "./routes/local-runs";
import { registerRunnerEventRoutes } from "./routes/runner-events";
import { registerRunSurfaceRoutes } from "./routes/run-surfaces";
import { registerAdminRoutes } from "./routes/admin";
import { registerStaffDeskRoutes } from "./routes/staff-desk";
import { registerActivityRoutes } from "./routes/activity";
import { registerSetupRoutes } from "./routes/setup";
import { createAuth, requestCf } from "./auth/better-auth";

/**
 * The Worker's HTTP surface. Kept apart from index.ts, which also exports the
 * Durable Object and RPC classes (`cloudflare:workers`), so that Node can
 * import the route table: the real-journeys authorization matrix reads
 * `app.routes` to know which routes exist (registeredRoutes below).
 */
const api = new Hono<AppEnv>();
registerSessionRoutes(api);
registerCohortRoutes(api);
registerGithubRoutes(api);
registerRunRoutes(api);
registerDashboardRoutes(api);
registerLeaderboardRoutes(api);
registerBenchmarkRoutes(api);
registerTeamRoutes(api);
registerTeamMembershipRoutes(api);
registerConnectionRoutes(api);
registerLocalReportRoutes(api);
registerLocalRunRoutes(api);
registerRunnerEventRoutes(api);
registerRunSurfaceRoutes(api);
registerAdminRoutes(api);
registerStaffDeskRoutes(api);
registerActivityRoutes(api);
registerSetupRoutes(api);
api.notFound((c) => errorResponse(c, 404, "not_found", "API route not found."));

export const app = new Hono<AppEnv>();
// Validate API configuration without blocking static assets on a bad binding.
app.use("/api/*", async (c, next) => {
  validateServerEnv(c.env);
  await next();
});
app.all("/api/auth/*", (c) =>
  createAuth(c.env, requestCf(c.req.raw), new URL(c.req.url).origin).handler(c.req.raw),
);
app.route("/api", api);
app.onError(handleError);
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api" || path.startsWith("/api/")) {
    return errorResponse(c, 404, "not_found", "API route not found.");
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

/**
 * Every route the app registers, as "METHOD /path", in registration order.
 * The env-validation middleware (`app.use("/api/*")`) is listed by Hono beside
 * the handlers but is not a route anyone can call, so it is left out.
 */
export function registeredRoutes(): string[] {
  const keys = app.routes
    .filter((route) => !(route.method === "ALL" && route.path === "/api/*"))
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(keys)];
}
