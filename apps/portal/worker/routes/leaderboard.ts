import type { Context, Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { LeaderboardSchema, SelectResultRequestSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { getAuth, requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import { leaderboardSelections, runs } from "../db/schema";
import { syncRun } from "../execution/sync";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { getLeaderboardReadModel } from "../services/leaderboard";

const OkSchema = z.object({ ok: z.literal(true) });

export function registerLeaderboardRoutes(app: Hono<AppEnv>): void {
  app.put("/leaderboard-selection", async (c) => {
    const auth = await requireTeam(c);
    const body = await parseBody(c, SelectResultRequestSchema);
    const db = getDb(c.env);
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, body.runId), eq(runs.teamId, auth.team.id)))
      .limit(1);
    if (!row) throw new ApiHttpError(404, "not_found", "Run not found.");
    const run = await syncRun(db, row);
    if (run.mode !== "official" || run.status !== "succeeded") {
      throw new ApiHttpError(409, "not_selectable", "Only a succeeded official run can be selected.");
    }
    await db
      .insert(leaderboardSelections)
      .values({
        teamId: auth.team.id,
        benchmarkId: run.benchmarkId,
        benchmarkVersion: run.benchmarkVersion,
        runId: run.id,
        selectedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [
          leaderboardSelections.teamId,
          leaderboardSelections.benchmarkId,
          leaderboardSelections.benchmarkVersion,
        ],
        set: { runId: run.id, selectedAt: Date.now() },
      });
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
