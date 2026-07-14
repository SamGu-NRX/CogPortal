import { Hono } from "hono";
import type { AppEnv } from "./env";
import { errorResponse, handleError } from "./http/errors";
import { registerBenchmarkRoutes } from "./routes/benchmarks";
import { registerCohortRoutes } from "./routes/cohorts";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerGithubRoutes } from "./routes/github";
import { registerLeaderboardRoutes } from "./routes/leaderboard";
import { registerRunRoutes } from "./routes/runs";
import { registerSessionRoutes } from "./routes/session";
import { registerTeamRoutes } from "./routes/team";
import { registerConnectionRoutes } from "./routes/connections";
import { registerLocalReportRoutes } from "./routes/local-reports";
import { registerRunnerEventRoutes } from "./routes/runner-events";
import { handleRunQueue } from "./execution/runner";
import { maintainPlatform } from "./execution/maintenance";
import type { RunJobV1 } from "@cogworks/contracts/protocol";
import { registerAdminRoutes } from "./routes/admin";

const api = new Hono<AppEnv>();
registerSessionRoutes(api);
registerCohortRoutes(api);
registerGithubRoutes(api);
registerRunRoutes(api);
registerDashboardRoutes(api);
registerLeaderboardRoutes(api);
registerBenchmarkRoutes(api);
registerTeamRoutes(api);
registerConnectionRoutes(api);
registerLocalReportRoutes(api);
registerRunnerEventRoutes(api);
registerAdminRoutes(api);
api.notFound((c) => errorResponse(c, 404, "not_found", "API route not found."));

const app = new Hono<AppEnv>();
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
