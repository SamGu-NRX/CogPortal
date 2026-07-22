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
import { handleRunQueue } from "./execution/runner";
import { maintainPlatform } from "./execution/maintenance";
import type { RunJobV1 } from "@cogworks/contracts/protocol";
import { registerAdminRoutes } from "./routes/admin";
import { registerActivityRoutes } from "./routes/activity";
import { registerSetupRoutes } from "./routes/setup";
import { createAuth, requestCf } from "./auth/better-auth";

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
registerActivityRoutes(api);
registerSetupRoutes(api);
api.notFound((c) => errorResponse(c, 404, "not_found", "API route not found."));

const app = new Hono<AppEnv>();
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

export { RunWorkflow } from "./orchestration/run-workflow";
export { PortalRpc } from "./rpc";
export { RunSurfaceHub } from "./realtime/run-surface-hub";
export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<RunJobV1>, env: AppEnv["Bindings"]) =>
    handleRunQueue(batch, env),
  scheduled: (
    _controller: ScheduledController,
    env: AppEnv["Bindings"],
    context: ExecutionContext,
  ) => {
    context.waitUntil(maintainPlatform(env));
  },
};
