import { and, desc, eq, inArray } from "drizzle-orm";
import type { Leaderboard, LeaderboardEntry } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import {
  benchmarks,
  leaderboardSelections,
  runMetrics,
  runs,
  teams,
} from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { serializeBenchmark, serializeMetric } from "../http/serializers";

export async function getLeaderboardReadModel(
  env: Env,
  benchmarkId?: string,
  teamId?: string,
): Promise<Leaderboard> {
  const db = getDb(env);
  const [benchmark] = benchmarkId
    ? await db
        .select()
        .from(benchmarks)
        .where(eq(benchmarks.id, benchmarkId))
        .orderBy(desc(benchmarks.version))
        .limit(1)
    : await db
        .select()
        .from(benchmarks)
        .where(eq(benchmarks.active, true))
        .orderBy(desc(benchmarks.version))
        .limit(1);
  if (!benchmark) throw new ApiHttpError(404, "not_found", "Benchmark not found.");

  const selected = await db
    .select({ run: runs, team: teams })
    .from(leaderboardSelections)
    .innerJoin(runs, eq(leaderboardSelections.runId, runs.id))
    .innerJoin(teams, eq(leaderboardSelections.teamId, teams.id))
    .where(
      and(
        eq(leaderboardSelections.benchmarkId, benchmark.id),
        eq(leaderboardSelections.benchmarkVersion, benchmark.version),
      ),
    );
  const metrics = selected.length
    ? await db
        .select()
        .from(runMetrics)
        .where(inArray(runMetrics.runId, selected.map((row) => row.run.id)))
    : [];
  const metricsByRun = new Map<string, typeof metrics>();
  for (const metric of metrics) {
    const values = metricsByRun.get(metric.runId) ?? [];
    values.push(metric);
    metricsByRun.set(metric.runId, values);
  }

  const entries: LeaderboardEntry[] = [];
  for (const row of selected) {
    const runMetricsForRow = metricsByRun.get(row.run.id) ?? [];
    const primary = runMetricsForRow.find((metric) => metric.isPrimary);
    if (!primary || row.run.finishedAt === null) continue;
    entries.push({
      rank: 0,
      teamName: row.team.name,
      teamDescription: row.team.description,
      repoUrl: row.team.repoUrl,
      sha: row.run.sha,
      shortSha: row.run.sha.slice(0, 7),
      primaryMetric: serializeMetric(primary),
      supportingMetrics: runMetricsForRow
        .filter((metric) => !metric.isPrimary)
        .map(serializeMetric),
      completedAt: row.run.finishedAt,
      isYou: teamId === row.team.id,
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
  return { benchmark: serializeBenchmark(benchmark), entries };
}
