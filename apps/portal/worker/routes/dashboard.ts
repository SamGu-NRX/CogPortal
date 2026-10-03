import type { Hono } from "hono";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { DashboardSchema, OFFICIAL_LIMIT, PRACTICE_LIMIT, runSource } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import {
  benchmarks,
  leaderboardSelections,
  runMetrics,
  runs,
  type RunRow,
} from "../db/schema";
import { syncTeamRuns } from "../execution/sync";
import { ApiHttpError } from "../http/errors";
import {
  buildRunSummary,
  readPrimaryMetrics,
  serializeBenchmark,
  serializeMetric,
  serializeTeam,
} from "../http/serializers";
import { respond } from "../http/respond";
import { runSourceRefusal } from "../services/run-source";
import { readRunAccounting } from "../services/run-accounting";
import {
  existingPromotion,
  NO_CONSOLE_PROMOTION_REFUSAL,
  rankingRefusal,
  savedEnvironmentEligibility,
} from "../services/run-eligibility";

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
    // Where else this team has run, so a track with no runs can point at the
    // team's work instead of reading as if nothing ever ran. Each count uses
    // that track's own filters: team, benchmark, and the version its tab
    // opens, which is the highest active one, as the lookup above picks.
    // Nothing stops two versions of a benchmark being active at once. Only
    // the first-run panel reads it, so a track with runs skips the query;
    // that includes every poll while a run is going, and nothing indexes runs
    // by team.
    const openVersions = db
      .select({ id: benchmarks.id, version: sql<number>`max(${benchmarks.version})`.as("open_version") })
      .from(benchmarks)
      .where(eq(benchmarks.active, true))
      .groupBy(benchmarks.id)
      .as("open_versions");
    const runsOnOtherTracks = allRuns.length > 0 ? [] : await db
      .select({ benchmarkId: runs.benchmarkId, title: benchmarks.title, runs: sql<number>`count(*)` })
      .from(runs)
      .innerJoin(openVersions, and(eq(openVersions.id, runs.benchmarkId), eq(openVersions.version, runs.benchmarkVersion)))
      .innerJoin(benchmarks, and(eq(benchmarks.id, runs.benchmarkId), eq(benchmarks.version, runs.benchmarkVersion)))
      .where(and(eq(runs.teamId, auth.team.id), ne(runs.benchmarkId, benchmark.id)))
      .groupBy(runs.benchmarkId, benchmarks.title)
      .orderBy(benchmarks.title);
    const accounting = await readRunAccounting(db, {
      teamId: auth.team.id, benchmarkId: benchmark.id, benchmarkVersion: benchmark.version,
    });
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

    const active = allRuns.find((run) => !["succeeded", "failed", "cancelled"].includes(run.status));
    const candidate = allRuns.find((run) => run.mode === "practice" && run.status === "succeeded" && run.refundedAt === null);
    // In the order promotion checks them: an attempt already promoted from
    // this console answers first, so the saved environment is only asked
    // about a run that has not been promoted.
    const promoted = candidate?.surfaceId
      ? existingPromotion(allRuns.filter((run) => run.surfaceId === candidate.surfaceId))
      : null;
    const promotionEligibility = candidate?.surfaceId && !promoted && c.env.EXECUTION_PROVIDER === "modal"
      ? savedEnvironmentEligibility(candidate, benchmark, auth.team) : null;
    const promotionRefusal = candidate && !candidate.surfaceId
      ? NO_CONSOLE_PROMOTION_REFUSAL
      : promoted?.refusal ?? (promotionEligibility?.eligible === false ? promotionEligibility.reason : null);

    // One statement for every primary metric this response needs: the run
    // log's rows and the two runs named above it. Read per run, this grew
    // with a team's history.
    const page = allRuns.slice(0, 50);
    const primaries = await readPrimaryMetrics(db, [...new Set([
      ...page.map((run) => run.id),
      ...(active ? [active.id] : []),
      ...(candidate ? [candidate.id] : []),
    ])]);
    const summarize = (run: RunRow) => buildRunSummary(run, primaries.get(run.id) ?? null);

    let selection = null;
    if (selectionRow) {
      const [selectedRun] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, selectionRow.runId))
        .limit(1);
      // The measure the board ranks, which a partial run's own primary flag
      // may not be. A selection the board leaves out is not shown as the
      // team's published result; the row itself stays stored.
      const [ranked] = await db
        .select()
        .from(runMetrics)
        .where(and(eq(runMetrics.runId, selectionRow.runId), eq(runMetrics.key, benchmark.primaryMetricKey)))
        .limit(1);
      if (selectedRun && ranked && rankingRefusal(selectedRun, benchmark, [ranked]) === null) {
        selection = {
          runId: selectedRun.id,
          source: runSource(selectedRun.repositoryFullName),
          selectedAt: selectionRow.selectedAt,
          primaryMetric: { ...serializeMetric(ranked), primary: true },
          shortSha: selectedRun.sha.slice(0, 7),
          attemptNumber: selectedRun.attemptNumber,
        };
      }
    }

    return respond(c, DashboardSchema, {
      benchmark: serializeBenchmark(benchmark),
      team: serializeTeam(auth.team),
      runsOnOtherTracks: runsOnOtherTracks.map((row) => ({ ...row, runs: Number(row.runs) })),
      quota: {
        practiceUsed: accounting.practiceUsed,
        practiceLimit: PRACTICE_LIMIT,
        officialUsed: accounting.officialUsed,
        officialLimit: OFFICIAL_LIMIT,
      },
      // "last tested" sits under the connected repository's name, so it has to
      // be a run of that repository. The newest run of any repository put the
      // old source's commit under the new source's name after a change, which
      // is the same misattribution the run page had.
      //
      // Matched on the repository id, the way `forConnectedRepository` in
      // routes/team.ts already decides which runs are evidence for the
      // connected repository. A run with no id cannot be shown to belong here,
      // so it does not fill this in, and the panel says none is recorded rather
      // than claiming none was ever run.
      lastResolvedSha:
        (auth.team.repoId === null
          ? undefined
          : allRuns.find((run) => run.repositoryId === auth.team.repoId)?.sha) ?? null,
      activeRun: active ? summarize(active) : null,
      latestCandidate: candidate
        ? {
            ...summarize(candidate),
            sourceRefusal: runSourceRefusal(auth.team, candidate, "promote it"),
            promotedTo: promoted?.promotedTo ?? null,
          }
        : null,
      promotionRefusal,
      selection,
      runs: page.map(summarize),
    });
  });
}
