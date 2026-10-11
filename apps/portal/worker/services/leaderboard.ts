import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  FamilyLeaderboard,
  Leaderboard,
  LeaderboardEntry,
} from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import {
  benchmarks,
  benchmarkFamilies,
  benchmarkFamilyComponents,
  leaderboardSelections,
  runMetrics,
  runs,
  teams,
} from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { canPublishOfficialRun } from "./run-eligibility";
import { serializeBenchmark, serializeMetric } from "../http/serializers";
import {
  hasSharedBenchmarkSource,
  weightedComponentScore,
} from "./benchmark-family";

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
    if (!canPublishOfficialRun(row.run)) continue;
    const runMetricsForRow = metricsByRun.get(row.run.id) ?? [];
    const primary = runMetricsForRow.find((metric) => metric.isPrimary);
    if (!primary || row.run.finishedAt === null) continue;
    entries.push({
      rank: 0,
      teamName: row.team.name,
      teamDescription: row.team.description,
      provenance: row.team.provenance,
      // An archive row is labeled anonymized on the page. The repository link
      // names a GitHub account and a commit SHA resolves to its repository
      // through GitHub search, so neither leaves the server for those rows.
      repoUrl: row.team.provenance === "archive" ? null : row.team.repoUrl,
      sha: row.team.provenance === "archive" ? "" : row.run.sha,
      shortSha: row.team.provenance === "archive" ? "" : row.run.sha.slice(0, 7),
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

export async function getFamilyLeaderboardReadModel(
  env: Env,
  familyId = "vision-overall",
  teamId?: string,
): Promise<FamilyLeaderboard> {
  const db = getDb(env);
  const [family] = await db
    .select()
    .from(benchmarkFamilies)
    .where(eq(benchmarkFamilies.id, familyId))
    .orderBy(desc(benchmarkFamilies.version))
    .limit(1);
  if (!family) throw new ApiHttpError(404, "not_found", "Benchmark family not found.");
  const components = await db
    .select()
    .from(benchmarkFamilyComponents)
    .where(
      and(
        eq(benchmarkFamilyComponents.familyId, family.id),
        eq(benchmarkFamilyComponents.familyVersion, family.version),
      ),
    )
    .orderBy(asc(benchmarkFamilyComponents.sortOrder));
  const selected = await db
    .select({ selection: leaderboardSelections, run: runs, team: teams })
    .from(leaderboardSelections)
    .innerJoin(runs, eq(leaderboardSelections.runId, runs.id))
    .innerJoin(teams, eq(leaderboardSelections.teamId, teams.id));
  const relevant = selected.filter((row) =>
    canPublishOfficialRun(row.run) && components.some(
      (component) =>
        component.benchmarkId === row.run.benchmarkId &&
        component.benchmarkVersion === row.run.benchmarkVersion,
    ),
  );
  const metrics = relevant.length
    ? await db
        .select()
        .from(runMetrics)
        .where(inArray(runMetrics.runId, relevant.map((row) => row.run.id)))
    : [];
  const metricsByRun = new Map<string, typeof metrics>();
  for (const metric of metrics) {
    const values = metricsByRun.get(metric.runId) ?? [];
    values.push(metric);
    metricsByRun.set(metric.runId, values);
  }

  const requiredTracks = new Set(
    components.map((component) => `${component.benchmarkId}@${component.benchmarkVersion}`),
  );
  const byTeam = new Map<string, typeof relevant>();
  for (const row of relevant) {
    const values = byTeam.get(row.team.id) ?? [];
    values.push(row);
    byTeam.set(row.team.id, values);
  }

  const entries: LeaderboardEntry[] = [];
  for (const rowsForTeam of byTeam.values()) {
    const runsByTrack = new Map(
      rowsForTeam.map((row) => [
        `${row.run.benchmarkId}@${row.run.benchmarkVersion}`,
        row,
      ]),
    );
    if ([...requiredTracks].some((track) => !runsByTrack.has(track))) continue;
    const selectedRows = [...requiredTracks].map((track) => runsByTrack.get(track)!);
    if (!hasSharedBenchmarkSource(selectedRows.map((row) => row.run))) continue;

    const componentMetrics = components.map((component) => {
      const row = runsByTrack.get(
        `${component.benchmarkId}@${component.benchmarkVersion}`,
      )!;
      const metric = (metricsByRun.get(row.run.id) ?? []).find(
        (value) => value.key === component.metricKey,
      );
      return metric ? { component, metric } : null;
    });
    if (componentMetrics.some((value) => value === null)) continue;
    const resolved = componentMetrics.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    const score = weightedComponentScore(
      resolved.map((value) => ({
        value: value.metric.value,
        weight: value.component.weight,
      })),
    );
    const row = selectedRows[0]!;
    entries.push({
      rank: 0,
      teamName: row.team.name,
      teamDescription: row.team.description,
      provenance: row.team.provenance,
      // An archive row is labeled anonymized on the page. The repository link
      // names a GitHub account and a commit SHA resolves to its repository
      // through GitHub search, so neither leaves the server for those rows.
      repoUrl: row.team.provenance === "archive" ? null : row.team.repoUrl,
      sha: row.team.provenance === "archive" ? "" : row.run.sha,
      shortSha: row.team.provenance === "archive" ? "" : row.run.sha.slice(0, 7),
      primaryMetric: {
        key: "overall",
        label: "Overall",
        value: score,
        unit: null,
        higherIsBetter: true,
        primary: true,
        precision: 3,
      },
      supportingMetrics: resolved.map(({ component, metric }) => ({
        ...serializeMetric(metric),
        key: component.key,
        label: component.label,
        primary: false,
      })),
      completedAt: Math.max(...selectedRows.map((value) => value.run.finishedAt ?? 0)),
      isYou: teamId === row.team.id,
    });
  }
  entries.sort(
    (left, right) =>
      right.primaryMetric.value - left.primaryMetric.value ||
      left.completedAt - right.completedAt,
  );
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return {
    family: {
      id: family.id,
      version: family.version,
      title: family.title,
      module: family.module,
      active: family.active,
      components: components.map((component) => ({
        key: component.key,
        label: component.label,
        benchmarkId: component.benchmarkId,
        benchmarkVersion: component.benchmarkVersion,
        metricKey: component.metricKey,
        weight: component.weight,
      })),
    },
    entries,
  };
}
