import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { LeaderboardSchema, SelectResultRequestSchema } from "@shared/schema";
import type { AppEnv } from "../env";
import { getAuth, requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import {
  benchmarks,
  leaderboardSelections,
  runMetrics,
  runs,
  teams,
} from "../db/schema";
import { syncRun } from "../execution/sync";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { serializeBenchmark, serializeMetric } from "../http/serializers";

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

  app.get("/leaderboard", async (c) => {
    const db = getDb(c.env);
    const requestedId = c.req.query("benchmark");
    const [benchmark] = requestedId
      ? await db
          .select()
          .from(benchmarks)
          .where(eq(benchmarks.id, requestedId))
          .orderBy(desc(benchmarks.version))
          .limit(1)
      : await db
          .select()
          .from(benchmarks)
          .where(eq(benchmarks.active, true))
          .orderBy(desc(benchmarks.version))
          .limit(1);
    if (!benchmark) throw new ApiHttpError(404, "not_found", "Benchmark not found.");
    const auth = await getAuth(c);
    const selected = await db
      .select({ selection: leaderboardSelections, run: runs, team: teams })
      .from(leaderboardSelections)
      .innerJoin(runs, eq(leaderboardSelections.runId, runs.id))
      .innerJoin(teams, eq(leaderboardSelections.teamId, teams.id))
      .where(
        and(
          eq(leaderboardSelections.benchmarkId, benchmark.id),
          eq(leaderboardSelections.benchmarkVersion, benchmark.version),
        ),
      );

    const entries = [];
    for (const row of selected) {
      const metrics = await db
        .select()
        .from(runMetrics)
        .where(eq(runMetrics.runId, row.run.id));
      const primary = metrics.find((metric) => metric.isPrimary);
      if (!primary || row.run.finishedAt === null) continue;
      entries.push({
        rank: 0,
        teamName: row.team.name,
        teamDescription: row.team.description,
        repoUrl: row.team.repoUrl,
        sha: row.run.sha,
        shortSha: row.run.sha.slice(0, 7),
        primaryMetric: serializeMetric(primary),
        supportingMetrics: metrics.filter((metric) => !metric.isPrimary).map(serializeMetric),
        completedAt: row.run.finishedAt,
        isYou: auth?.team?.id === row.team.id,
      });
    }
    entries.sort((left, right) => {
      const direction = left.primaryMetric.higherIsBetter ? -1 : 1;
      const scoreOrder = direction * (left.primaryMetric.value - right.primaryMetric.value);
      return scoreOrder !== 0 ? scoreOrder : left.completedAt - right.completedAt;
    });
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    return respond(c, LeaderboardSchema, {
      benchmark: serializeBenchmark(benchmark),
      entries,
    });
  });
}
