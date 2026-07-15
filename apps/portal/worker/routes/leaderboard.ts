import type { Context, Hono } from "hono";
import { z } from "zod";
import { LeaderboardSchema, SelectResultRequestSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { getAuth, requireTeam } from "../auth/session";
import { parseBody, respond } from "../http/respond";
import { getLeaderboardReadModel } from "../services/leaderboard";
import { actorFromAuth, publishOfficialRun } from "../services/run-actions";

const OkSchema = z.object({ ok: z.literal(true) });

export function registerLeaderboardRoutes(app: Hono<AppEnv>): void {
  app.put("/leaderboard-selection", async (c) => {
    const auth = await requireTeam(c);
    const body = await parseBody(c, SelectResultRequestSchema);
    await publishOfficialRun(c.env, actorFromAuth(auth), body.runId);
    return respond(c, OkSchema, { ok: true });
  });

  const leaderboardHandler = async (c: Context<AppEnv>) => {
    const auth = await getAuth(c);
    return respond(
      c,
      LeaderboardSchema,
      await getLeaderboardReadModel(c.env, c.req.query("benchmark"), auth?.team?.id),
    );
  };
  app.get("/leaderboard", leaderboardHandler);
  app.get("/v1/leaderboard", leaderboardHandler);
}
