import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
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
  officialPromotionRefusal,
  rankingRefusal,
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
    const blocked = candidate?.surfaceId && !promoted && c.env.EXECUTION_PROVIDER === "modal"
      ? officialPromotionRefusal(candidate, benchmark, auth.team) : null;
    const promotionRefusal = candidate && !candidate.surfaceId
      ? NO_CONSOLE_PROMOTION_REFUSAL
      : promoted?.refusal ?? blocked;

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
