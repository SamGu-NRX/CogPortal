import type { AppEnv } from "./env";
import { app } from "./app";
import { handleRunQueue } from "./execution/runner";
import { maintainPlatform } from "./execution/maintenance";
import type { RunJobV1 } from "@cogworks/contracts/protocol";

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
