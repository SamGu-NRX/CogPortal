import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  FamilyLeaderboardSchema,
  LeaderboardSchema,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { getAuth, requireTeam } from "../auth/session";
import { guardField, respond } from "../http/respond";
import {
  getFamilyLeaderboardReadModel,
  getLeaderboardReadModel,
} from "../services/leaderboard";
import { actorFromAuth, publishOfficialRun } from "../services/run-actions";

const OkSchema = z.object({ ok: z.literal(true) });

export function registerLeaderboardRoutes(app: Hono<AppEnv>): void {
  app.put("/leaderboard-selection", async (c) => {
    const auth = await requireTeam(c);
    // The service settles write access before it reads the run id, so a
    // caller without it is refused for that, never for a malformed body.
    await publishOfficialRun(c.env, actorFromAuth(auth), await guardField(c, "runId"));
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
  app.get("/leaderboard-family", async (c) => {
    const auth = await getAuth(c);
    return respond(
      c,
      FamilyLeaderboardSchema,
      await getFamilyLeaderboardReadModel(
        c.env,
        c.req.query("family") ?? "vision-overall",
        auth?.team?.id,
      ),
    );
  });
}
