import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { FIXTURE_REPO } from "@shared/fixtures";
import {
  OFFICIAL_LIMIT,
  PRACTICE_LIMIT,
  RUN_PHASES,
  RunDetailSchema,
  RunSummarySchema,
  StartPracticeRequestSchema,
  StartRunResponseSchema,
  isTerminal,
} from "@shared/schema";
import type { AppEnv } from "../env";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import {
  benchmarks,
  officialAttempts,
  runPhases,
  runs,
  type BenchmarkRow,
  type RunRow,
} from "../db/schema";
import { syncRun, syncTeamRuns } from "../execution/sync";
import { FixtureGitHubClient, RealGitHubClient } from "../github/client";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { serializeRunDetail, serializeRunSummary } from "../http/serializers";
import { newId, randomHex } from "../util/id";

async function activeBenchmark(
  db: ReturnType<typeof getDb>,
  benchmarkId: string,
): Promise<BenchmarkRow> {
  const [benchmark] = await db
    .select()
    .from(benchmarks)
    .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.active, true)))
    .orderBy(desc(benchmarks.version))
    .limit(1);
  if (!benchmark) {
    throw new ApiHttpError(404, "invalid_request", "Active benchmark not found.");
  }
  return benchmark;
}

function hasActive(rowsForTeam: RunRow[]): boolean {
  return rowsForTeam.some((run) => !isTerminal(run.status));
}

async function insertPhaseSkeleton(db: ReturnType<typeof getDb>, runId: string): Promise<void> {
  await db.insert(runPhases).values(
    RUN_PHASES.map((phase) => ({ runId, phase, startedAt: null, endedAt: null })),
  );
}

export function registerRunRoutes(app: Hono<AppEnv>): void {
  app.post("/runs/practice", async (c) => {
    const auth = await requireTeam(c);
    const body = await parseBody(c, StartPracticeRequestSchema);
    const db = getDb(c.env);
    const benchmark = await activeBenchmark(db, body.benchmarkId);
    const teamRuns = await syncTeamRuns(db, auth.team.id, benchmark.id);
    if (hasActive(teamRuns)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    const practiceUsed = teamRuns.filter(
      (run) => run.mode === "practice" && run.benchmarkVersion === benchmark.version,
    ).length;
    if (practiceUsed >= PRACTICE_LIMIT) {
      throw new ApiHttpError(409, "quota_exhausted", "The practice-run quota is exhausted.");
    }
    const fixtureRepository = auth.team.repoFullName === FIXTURE_REPO.fullName;
    const oauthToken = auth.oauthToken;
    if (!fixtureRepository && !oauthToken) {
      throw new ApiHttpError(
        403,
        "forbidden",
        "Sign in with GitHub to run this repository.",
      );
    }
    // NOTE(M0): Real repositories currently execute through the fixture engine until the sandbox
    // provider gate passes. Collaborator permission is verified at connect time in v1; re-checking
    // it for each mutating action remains a TODO.
    if (c.env.EXECUTION_PROVIDER !== "fixture") {
      throw new ApiHttpError(501, "provider_unconfigured", "Sandbox execution has not passed Milestone 0.");
    }

    const branch = body.branch ?? auth.team.defaultBranch;
    let sha: string;
    if (fixtureRepository) {
      sha = await new FixtureGitHubClient().resolveRef(
        auth.team.repoOwner,
        auth.team.repoName,
        branch,
      );
    } else if (oauthToken) {
      sha = await new RealGitHubClient().resolveRef(
        auth.team.repoOwner,
        auth.team.repoName,
        branch,
        oauthToken,
      );
    } else {
      throw new ApiHttpError(
        403,
        "forbidden",
        "Sign in with GitHub to run this repository.",
      );
    }
    const runId = `run_${randomHex(5)}`;
    await db.insert(runs).values({
      id: runId,
      teamId: auth.team.id,
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
      contractVersion: benchmark.contractVersion,
      mode: "practice",
      status: "queued",
      branch,
      sha,
      parentRunId: null,
      attemptNumber: null,
      failureCategory: null,
      failurePhase: null,
      failureDetail: null,
      failureConsumedAttempt: false,
      log: null,
      createdAt: Date.now(),
      finishedAt: null,
    });
    await insertPhaseSkeleton(db, runId);
    return respond(c, StartRunResponseSchema, { runId }, 201);
  });

  app.post("/runs/:id/promote", async (c) => {
    const auth = await requireTeam(c);
    const db = getDb(c.env);
    const [parentRow] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, c.req.param("id")), eq(runs.teamId, auth.team.id)))
      .limit(1);
    if (!parentRow) throw new ApiHttpError(404, "not_found", "Run not found.");
    const parent = await syncRun(db, parentRow);
    if (parent.mode !== "practice" || parent.status !== "succeeded") {
      throw new ApiHttpError(409, "not_promotable", "Only a succeeded practice run can be promoted.");
    }
    const teamRuns = await syncTeamRuns(db, auth.team.id, parent.benchmarkId);
    if (hasActive(teamRuns)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    const claims = await db
      .select()
      .from(officialAttempts)
      .where(
        and(
          eq(officialAttempts.teamId, auth.team.id),
          eq(officialAttempts.benchmarkId, parent.benchmarkId),
          eq(officialAttempts.benchmarkVersion, parent.benchmarkVersion),
        ),
      );
    if (claims.length >= OFFICIAL_LIMIT) {
      throw new ApiHttpError(409, "quota_exhausted", "The official-attempt quota is exhausted.");
    }
    if (c.env.EXECUTION_PROVIDER !== "fixture") {
      throw new ApiHttpError(501, "provider_unconfigured", "Sandbox execution has not passed Milestone 0.");
    }

    const attemptNumber = claims.length + 1;
    const runId = `run_${randomHex(5)}`;
    const now = Date.now();
    try {
      await db.insert(runs).values({
        id: runId,
        teamId: auth.team.id,
        benchmarkId: parent.benchmarkId,
        benchmarkVersion: parent.benchmarkVersion,
        contractVersion: parent.contractVersion,
        mode: "official",
        status: "queued",
        branch: parent.branch,
        sha: parent.sha,
        parentRunId: parent.id,
        attemptNumber,
        failureCategory: null,
        failurePhase: null,
        failureDetail: null,
        failureConsumedAttempt: false,
        log: null,
        createdAt: now,
        finishedAt: null,
      });
      await db.insert(officialAttempts).values({
        id: newId("attempt_"),
        teamId: auth.team.id,
        benchmarkId: parent.benchmarkId,
        benchmarkVersion: parent.benchmarkVersion,
        runId,
        attemptNumber,
        consumed: false,
        claimedAt: now,
      });
    } catch {
      await db.delete(runs).where(eq(runs.id, runId));
      throw new ApiHttpError(409, "quota_exhausted", "The official attempt could not be claimed.");
    }
    await insertPhaseSkeleton(db, runId);
    return respond(c, StartRunResponseSchema, { runId }, 201);
  });

  app.get("/runs", async (c) => {
    const auth = await requireTeam(c);
    const benchmarkId = c.req.query("benchmark");
    const db = getDb(c.env);
    await syncTeamRuns(db, auth.team.id, benchmarkId);
    const rows = await db
      .select()
      .from(runs)
      .where(
        benchmarkId
          ? and(eq(runs.teamId, auth.team.id), eq(runs.benchmarkId, benchmarkId))
          : eq(runs.teamId, auth.team.id),
      )
      .orderBy(desc(runs.createdAt));
    const summaries = await Promise.all(rows.map((run) => serializeRunSummary(db, run)));
    return respond(c, z.array(RunSummarySchema), summaries);
  });

  app.get("/runs/:id", async (c) => {
    const auth = await requireTeam(c);
    const db = getDb(c.env);
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, c.req.param("id")), eq(runs.teamId, auth.team.id)))
      .limit(1);
    if (!row) throw new ApiHttpError(404, "not_found", "Run not found.");
    const run = await syncRun(db, row);
    return respond(c, RunDetailSchema, await serializeRunDetail(db, run, auth.team));
  });
}
