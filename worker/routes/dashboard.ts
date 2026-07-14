import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { DashboardSchema, OFFICIAL_LIMIT, PRACTICE_LIMIT } from "@shared/schema";
import type { AppEnv } from "../env";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import {
  benchmarks,
  leaderboardSelections,
  officialAttempts,
  runMetrics,
  runs,
} from "../db/schema";
import { syncTeamRuns } from "../execution/sync";
import { ApiHttpError } from "../http/errors";
import {
  serializeBenchmark,
  serializeMetric,
  serializeRunSummary,
  serializeTeam,
} from "../http/serializers";
import { respond } from "../http/respond";

export function registerDashboardRoutes(app: Hono<AppEnv>): void {
  app.get("/dashboard", async (c) => {
    const auth = await requireTeam(c);
    const db = getDb(c.env);
    const requestedId = c.req.query("benchmark");
    const [benchmark] = await db
      .select()
      .from(benchmarks)
      .where(
        requestedId
          ? and(eq(benchmarks.id, requestedId), eq(benchmarks.active, true))
          : eq(benchmarks.active, true),
      )
      .orderBy(desc(benchmarks.version))
      .limit(1);
    if (!benchmark) throw new ApiHttpError(404, "invalid_request", "Active benchmark not found.");

    await syncTeamRuns(db, auth.team.id, benchmark.id);
    const allRuns = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.teamId, auth.team.id),
          eq(runs.benchmarkId, benchmark.id),
          eq(runs.benchmarkVersion, benchmark.version),
        ),
      )
      .orderBy(desc(runs.createdAt));
    const claims = await db
      .select()
      .from(officialAttempts)
      .where(
        and(
          eq(officialAttempts.teamId, auth.team.id),
          eq(officialAttempts.benchmarkId, benchmark.id),
          eq(officialAttempts.benchmarkVersion, benchmark.version),
        ),
      );
    const [selectionRow] = await db
      .select()
      .from(leaderboardSelections)
      .where(
        and(
          eq(leaderboardSelections.teamId, auth.team.id),
          eq(leaderboardSelections.benchmarkId, benchmark.id),
          eq(leaderboardSelections.benchmarkVersion, benchmark.version),
        ),
      )
      .limit(1);

    let selection = null;
    if (selectionRow) {
      const [selectedRun] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, selectionRow.runId))
        .limit(1);
      const [primary] = await db
        .select()
        .from(runMetrics)
        .where(and(eq(runMetrics.runId, selectionRow.runId), eq(runMetrics.isPrimary, true)))
        .limit(1);
      if (selectedRun && primary) {
        selection = {
          runId: selectedRun.id,
          selectedAt: selectionRow.selectedAt,
          primaryMetric: serializeMetric(primary),
          shortSha: selectedRun.sha.slice(0, 7),
          attemptNumber: selectedRun.attemptNumber,
        };
      }
    }

    const active = allRuns.find((run) => !["succeeded", "failed", "cancelled"].includes(run.status));
    const candidate = allRuns.find((run) => run.mode === "practice" && run.status === "succeeded");
    const summaries = await Promise.all(allRuns.slice(0, 50).map((run) => serializeRunSummary(db, run)));
    return respond(c, DashboardSchema, {
      benchmark: serializeBenchmark(benchmark),
      team: serializeTeam(auth.team),
      quota: {
        practiceUsed: allRuns.filter((run) => run.mode === "practice").length,
        practiceLimit: PRACTICE_LIMIT,
        officialUsed: claims.length,
        officialLimit: OFFICIAL_LIMIT,
      },
      lastResolvedSha: allRuns[0]?.sha ?? null,
      activeRun: active ? await serializeRunSummary(db, active) : null,
      latestCandidate: candidate ? await serializeRunSummary(db, candidate) : null,
      selection,
      runs: summaries,
    });
  });
}
