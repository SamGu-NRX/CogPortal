import type { Hono } from "hono";
import { z } from "zod";
import { RetryRunRequestSchema, RunSurfaceSnapshotSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireTeam } from "../auth/session";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { buildRunSurfaceSnapshot, getRunSurfaceRow, listTeamRunSurfaceSnapshots } from "../services/run-surfaces";
import { actorFromAuth, performRunSurfaceMutation } from "../services/run-actions";

const MUTATIONS = ["verify_hosted", "promote_official", "publish_result", "rerun_hosted", "retry"] as const;
const MutationSchema = z.enum(MUTATIONS);

async function requireTeamSurface(env: AppEnv["Bindings"], teamId: string, surfaceId: string) {
  const surface = await getRunSurfaceRow(env, surfaceId);
  if (surface.teamId !== teamId) throw new ApiHttpError(404, "not_found", "Run surface not found.");
  return surface;
}

export function registerRunSurfaceRoutes(app: Hono<AppEnv>): void {
  app.get("/run-surfaces", async (c) => {
    const auth = await requireTeam(c);
    return respond(
      c,
      z.array(RunSurfaceSnapshotSchema),
      await listTeamRunSurfaceSnapshots(c.env, auth.team.id),
    );
  });

  app.get("/run-surfaces/:id", async (c) => {
    const auth = await requireTeam(c);
    await requireTeamSurface(c.env, auth.team.id, c.req.param("id"));
    return respond(c, RunSurfaceSnapshotSchema, await buildRunSurfaceSnapshot(c.env, c.req.param("id")));
  });

  app.post("/run-surfaces/:id/actions/:action", async (c) => {
    const auth = await requireTeam(c);
    const surfaceId = c.req.param("id");
    await requireTeamSurface(c.env, auth.team.id, surfaceId);
    const action = MutationSchema.parse(c.req.param("action"));
    const snapshot = await performRunSurfaceMutation(
      c.env,
      actorFromAuth(auth),
      surfaceId,
      action,
      action === "retry" ? await parseBody(c, RetryRunRequestSchema) : undefined,
    );
    return respond(c, RunSurfaceSnapshotSchema, snapshot);
  });

  app.get("/run-surfaces/:id/stream", async (c) => {
    const auth = await requireTeam(c);
    const surfaceId = c.req.param("id");
    await requireTeamSurface(c.env, auth.team.id, surfaceId);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: { code: "invalid_request", message: "Expected a WebSocket upgrade." } }, 426);
    }
    const stub = c.env.RUN_SURFACES.get(c.env.RUN_SURFACES.idFromName(surfaceId));
    return stub.fetch(
      new Request(`https://run-surface.internal/connect?surfaceId=${encodeURIComponent(surfaceId)}`, {
        headers: c.req.raw.headers,
      }),
    );
  });
}
