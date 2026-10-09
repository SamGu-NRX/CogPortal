import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  runSource,
  type FamilyLeaderboard,
  type Leaderboard,
  type LeaderboardEntry,
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
import { canPublishOfficialRun, rankingRefusal } from "./run-eligibility";
import { serializeBenchmark, serializeMetric } from "../http/serializers";
import {
  hasSharedBenchmarkSource,
  weightedComponentScore,
} from "./benchmark-family";
import { projectPublicSweep } from "./public-sweep";

export async function getLeaderboardReadModel(
  env: Env,
  benchmarkId?: string,
  teamId?: string,
): Promise<Leaderboard> {
  const db = getDb(env);
  // A benchmark id can name several versions. The board must open on the
  // newest version that is still active: an inactive newest version (a
  // scorer or track withdrawn mid-course) must not outrank the active one,
  // or a leaderboard link would silently resolve to a measure that is no
  // longer in force. Ordering active first, then version, keeps that
  // guarantee in one statement; when no version is active the same order
  // still reaches the newest row, which is what an archive board shows.
  const [benchmark] = benchmarkId
    ? await db
        .select()
        .from(benchmarks)
        .where(eq(benchmarks.id, benchmarkId))
        .orderBy(desc(benchmarks.active), desc(benchmarks.version))
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
        // Historical selections stay stored, but different scorers do not rank together.
        eq(runs.scorerVersion, benchmark.scorerVersion),
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
    // The catalog's measure, not the run's own primary flag.
    const ranked = runMetricsForRow.find((metric) => metric.key === benchmark.primaryMetricKey);
    if (!ranked || rankingRefusal(row.run, benchmark, runMetricsForRow) !== null || row.run.finishedAt === null) {
      continue;
    }
    entries.push({
      rank: 0,
      teamName: row.team.name,
      teamDescription: row.team.description,
      provenance: row.team.provenance,
      // An archive row is labeled anonymized on the page. The repository link
      // names a GitHub account and a commit SHA resolves to its repository
      // through GitHub search, so neither leaves the server for those rows.
      //
      // Otherwise the link names the repository this run used, which is not
      // always the one the team has now. Pairing the team's current repository
      // with a published run's commit sent a reader to a repository that never
      // held it. Null when the run predates the recorded name; the page
      // already omits the row rather than showing a guess.
      repoUrl:
        row.team.provenance === "archive"
          ? null
          : (runSource(row.run.repositoryFullName)?.url ?? null),
      sha: row.team.provenance === "archive" ? "" : row.run.sha,
      shortSha: row.team.provenance === "archive" ? "" : row.run.sha.slice(0, 7),
      primaryMetric: { ...serializeMetric(ranked), primary: true },
      supportingMetrics: runMetricsForRow
        .filter((metric) => metric !== ranked)
        .map((metric) => ({ ...serializeMetric(metric), primary: false })),
      completedAt: row.run.finishedAt,
      isYou: teamId === row.team.id,
      // Per entry and never throwing: a malformed stored curve costs this
      // run its curve and leaves every other entry as it was.
      publicSweep: projectPublicSweep(row.run, new Map(runMetricsForRow.map((metric) => [metric.key, metric.value]))),
    });
  }
  // One key under one scorer should carry one direction. Two means the
  // scorer's direction changed without a new scorer version, and any order
  // picked here would be a guess presented as a ranking.
  const directions = new Set(entries.map((entry) => entry.primaryMetric.higherIsBetter));
  if (directions.size > 1) {
    throw new Error(
      `Leaderboard ${benchmark.id}@${benchmark.version}: "${benchmark.primaryMetricKey}" under scorer ` +
      `${benchmark.scorerVersion} is stored as both higher-is-better and lower-is-better; bump the scorer version.`,
    );
  }
  const direction = entries[0]?.primaryMetric.higherIsBetter === false ? 1 : -1;
  entries.sort((left, right) =>
    direction * (left.primaryMetric.value - right.primaryMetric.value) ||
    left.completedAt - right.completedAt);
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
  // The same catalog rows the selection query below joins on, so the scorer
  // this response names is the one that decided which runs count.
  const catalog = components.length
    ? await db
        .select({ id: benchmarks.id, version: benchmarks.version, scorerVersion: benchmarks.scorerVersion })
        .from(benchmarks)
        .where(inArray(benchmarks.id, [...new Set(components.map((component) => component.benchmarkId))]))
    : [];
  const scorerFor = (benchmarkId: string, benchmarkVersion: number) =>
    catalog.find((row) => row.id === benchmarkId && row.version === benchmarkVersion)?.scorerVersion ?? null;
  const selected = await db
    .select({ selection: leaderboardSelections, run: runs, team: teams, benchmark: benchmarks })
    .from(leaderboardSelections)
    .innerJoin(runs, eq(leaderboardSelections.runId, runs.id))
    .innerJoin(teams, eq(leaderboardSelections.teamId, teams.id))
    .innerJoin(
      benchmarks,
      and(
        eq(runs.benchmarkId, benchmarks.id),
        eq(runs.benchmarkVersion, benchmarks.version),
        eq(runs.scorerVersion, benchmarks.scorerVersion),
      ),
    );
  const candidates = selected.filter((row) =>
    canPublishOfficialRun(row.run) && components.some(
      (component) =>
        component.benchmarkId === row.run.benchmarkId &&
        component.benchmarkVersion === row.run.benchmarkVersion,
    ),
  );
  const metrics = candidates.length
    ? await db
        .select()
        .from(runMetrics)
        .where(inArray(runMetrics.runId, candidates.map((row) => row.run.id)))
    : [];
  const metricsByRun = new Map<string, typeof metrics>();
  for (const metric of metrics) {
    const values = metricsByRun.get(metric.runId) ?? [];
    values.push(metric);
    metricsByRun.set(metric.runId, values);
  }
  // A selection its own board leaves out (no reading for the catalog's ranked
  // measure) isn't published, so it can't count toward the family either.
  const relevant = candidates.filter((row) =>
    rankingRefusal(row.run, row.benchmark, metricsByRun.get(row.run.id) ?? []) === null);

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
      //
      // Otherwise the link names the repository this run used, which is not
      // always the one the team has now. Pairing the team's current repository
      // with a published run's commit sent a reader to a repository that never
      // held it. Null when the run predates the recorded name; the page
      // already omits the row rather than showing a guess.
      repoUrl:
        row.team.provenance === "archive"
          ? null
          : (runSource(row.run.repositoryFullName)?.url ?? null),
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
      // Overall is a weighted sum of three runs' numbers; no run measured a
      // curve for it, so none is drawn.
      publicSweep: null,
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
        scorerVersion: scorerFor(component.benchmarkId, component.benchmarkVersion),
      })),
    },
    entries,
  };
}
