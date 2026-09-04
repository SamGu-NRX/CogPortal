import { and, desc, eq } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  OFFICIAL_LIMIT,
  PRACTICE_LIMIT,
  RUN_PHASES,
  isTerminal,
} from "@cogworks/contracts/schema";
import type { AuthState } from "../auth/session";
import { createAuth, getGithubToken } from "../auth/better-auth";
import type { Env } from "../env";
import { getDb } from "../db/client";
import {
  benchmarks,
  discordAccounts,
  leaderboardSelections,
  localRunSessions,
  officialAttempts,
  runPhases,
  runs,
  runSurfaces,
  teamMembers,
  teams,
  users,
  type BenchmarkRow,
  type RunRow,
  type TeamRow,
} from "../db/schema";
import { syncRun, syncTeamRuns } from "../execution/sync";
import { assertModalConfigured, enqueueRun } from "../execution/runner";
import { FixtureGitHubClient, RealGitHubClient } from "../github/client";
import { ApiHttpError } from "../http/errors";
import { newId, randomHex } from "../util/id";
import { sha256Hex } from "../util/crypto";
import { publishRunSurface } from "./run-surfaces";

export interface RunActor {
  userId: string;
  githubLogin: string | null;
  team: TeamRow;
  role: "admin" | "maintain" | "write";
}

export function actorFromAuth(auth: AuthState & { team: TeamRow }): RunActor {
  return {
    userId: auth.user.id,
    githubLogin: auth.user.githubLogin,
    team: auth.team,
    role: "write",
  };
}

export async function discordRunActor(env: Env, discordUserId: string): Promise<RunActor> {
  const db = getDb(env);
  const [identity] = await db
    .select({ userId: users.id, githubLogin: users.githubLogin })
    .from(discordAccounts)
    .innerJoin(users, eq(discordAccounts.userId, users.id))
    .where(eq(discordAccounts.discordUserId, discordUserId))
    .limit(1);
  if (!identity) throw new ApiHttpError(401, "unauthorized", "Link Discord to Cog*Portal first.");
  const [membership] = await db
    .select({ team: teams, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, identity.userId))
    .limit(1);
  if (!membership || !["admin", "maintain", "write"].includes(membership.role)) {
    throw new ApiHttpError(403, "forbidden", "Current write access to the team repository is required.");
  }
  return {
    userId: identity.userId,
    githubLogin: identity.githubLogin,
    team: membership.team,
    role: membership.role as RunActor["role"],
  };
}

export async function requireCurrentRepositoryPermission(
  env: Env,
  actor: RunActor,
): Promise<string | null> {
  if (actor.team.repoFullName === FIXTURE_REPO.fullName) return null;
  const githubToken = await getGithubToken(createAuth(env), actor.userId);
  if (!githubToken || !actor.githubLogin) {
    throw new ApiHttpError(403, "forbidden", "Sign in to GitHub on Cog*Portal before changing a run.");
  }
  let permission: string;
  try {
    permission = await new RealGitHubClient().getPermission(
      actor.team.repoFullName,
      actor.githubLogin,
      githubToken,
    );
  } catch {
    throw new ApiHttpError(403, "forbidden", "GitHub access expired. Sign in to Cog*Portal again.");
  }
  if (!["admin", "maintain", "write", "push"].includes(permission)) {
    throw new ApiHttpError(403, "forbidden", "Current write permission to the connected repository is required.");
  }
  return githubToken;
}

async function activeBenchmark(env: Env, benchmarkId: string, version?: number): Promise<BenchmarkRow> {
  const rows = await getDb(env)
    .select()
    .from(benchmarks)
    .where(
      version == null
        ? and(eq(benchmarks.id, benchmarkId), eq(benchmarks.active, true))
        : and(
            eq(benchmarks.id, benchmarkId),
            eq(benchmarks.version, version),
            eq(benchmarks.active, true),
          ),
    )
    .orderBy(desc(benchmarks.version))
    .limit(1);
  if (!rows[0]) throw new ApiHttpError(409, "not_promotable", "That benchmark version is not active.");
  return rows[0];
}

function hasActive(rowsForTeam: RunRow[]): boolean {
  return rowsForTeam.some((run) => !isTerminal(run.status));
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

function existingOfficialPromotion(run: RunRow, surfaceId: string) {
  if (run.status === "failed") {
    throw new ApiHttpError(
      409,
      "not_promotable",
      "That official attempt already ran and failed. Start a new practice run to create the next candidate to promote.",
    );
  }
  return { runId: run.id, surfaceId };
}

async function insertPhaseSkeleton(env: Env, runId: string): Promise<void> {
  await getDb(env).insert(runPhases).values(
    RUN_PHASES.map((phase) => ({ runId, phase, startedAt: null, endedAt: null })),
  );
}

async function dispatch(env: Env, runId: string, team: TeamRow, benchmark: BenchmarkRow) {
  if (env.EXECUTION_PROVIDER !== "modal") return;
  const [run] = await getDb(env).select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new ApiHttpError(500, "provider_unconfigured", "Run could not be loaded.");
  try {
    await enqueueRun(env, run, team, benchmark);
  } catch {
    // The provider never accepted the job (enqueueRun only rejects before
    // acceptance). The failed-run update and the claim release commit as one
    // D1 batch, because either half alone is a lie: a failed run keeping its
    // claim silently spends an attempt, and a released claim on a still-queued
    // run leaves a claimless run holding the active-run index.
    const db = getDb(env);
    const failRun = db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: Date.now(),
        failureCategory: "provider",
        failurePhase: "queued",
        failureDetail: "The run could not be queued for Modal.",
      })
      .where(eq(runs.id, runId));
    if (run.mode === "official") {
      await db.batch([failRun, db.delete(officialAttempts).where(eq(officialAttempts.runId, runId))]);
    } else {
      await failRun;
    }
    throw new ApiHttpError(502, "provider_unconfigured", "The run could not be queued. Try again.");
  }
}

interface StartPracticeOptions {
  benchmarkId: string;
  branch?: string | null;
  exactSha?: string;
  surfaceId?: string;
  supersedesSurfaceId?: string | null;
}

export async function startPracticeRun(
  env: Env,
  actor: RunActor,
  options: StartPracticeOptions,
): Promise<{ runId: string; surfaceId: string }> {
  const githubToken = await requireCurrentRepositoryPermission(env, actor);
  const db = getDb(env);
  const benchmark = await activeBenchmark(env, options.benchmarkId);
  if (options.surfaceId) {
    const [existing] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.surfaceId, options.surfaceId), eq(runs.mode, "practice")))
      .limit(1);
    if (existing) return { runId: existing.id, surfaceId: options.surfaceId };
  }
  const teamRuns = await syncTeamRuns(db, actor.team.id, benchmark.id);
  if (hasActive(teamRuns)) throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
  const practiceUsed = teamRuns.filter(
    (run) => run.mode === "practice" && run.benchmarkVersion === benchmark.version,
  ).length;
  if (practiceUsed >= PRACTICE_LIMIT) throw new ApiHttpError(409, "quota_exhausted", "The practice-run quota is exhausted.");
  if (env.EXECUTION_PROVIDER === "modal") assertModalConfigured(env);

  const fixtureRepository = actor.team.repoFullName === FIXTURE_REPO.fullName;
  const branch = options.branch || actor.team.defaultBranch;
  let sha: string;
  if (options.exactSha) {
    if (!/^[a-f0-9]{40}$/.test(options.exactSha)) {
      throw new ApiHttpError(409, "invalid_request", "The local commit SHA is invalid.");
    }
    if (fixtureRepository) {
      sha = options.exactSha;
    } else if (githubToken) {
      try {
        sha = await new RealGitHubClient().resolveRef(
          actor.team.repoOwner,
          actor.team.repoName,
          options.exactSha,
          githubToken,
        );
      } catch {
        throw new ApiHttpError(
          409,
          "invalid_request",
          `Push ${options.exactSha.slice(0, 7)} to GitHub first.`,
        );
      }
      if (sha.toLowerCase() !== options.exactSha.toLowerCase()) {
        throw new ApiHttpError(409, "invalid_request", "GitHub resolved a different commit.");
      }
    } else {
      throw new ApiHttpError(403, "forbidden", "Sign in to GitHub on Cog*Portal first.");
    }
  } else if (fixtureRepository) {
    sha = await new FixtureGitHubClient().resolveRef(actor.team.repoOwner, actor.team.repoName, branch);
  } else if (githubToken) {
    try {
      sha = await new RealGitHubClient().resolveRef(actor.team.repoOwner, actor.team.repoName, branch, githubToken);
    } catch {
      // The exact-sha path above says "push it first"; a branch that GitHub
      // cannot resolve deserves a sentence too, not a bare 500.
      throw new ApiHttpError(409, "invalid_request", `GitHub has no branch named ${branch}.`);
    }
  } else {
    throw new ApiHttpError(403, "forbidden", "Sign in to GitHub on Cog*Portal first.");
  }

  const surfaceId = options.surfaceId ?? `surface_${randomHex(10)}`;
  const now = Date.now();
  await db
    .insert(runSurfaces)
    .values({
      id: surfaceId,
      teamId: actor.team.id,
      createdByUserId: actor.userId,
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
      localRunId: null,
      supersedesSurfaceId: options.supersedesSurfaceId ?? null,
      discordChannelId: actor.team.discordChannelId,
      discordMessageId: null,
      discordNonceGeneration: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const runId = `run_${randomHex(5)}`;
  try {
    await db.insert(runs).values({
      id: runId,
      teamId: actor.team.id,
      benchmarkId: benchmark.id,
      benchmarkVersion: benchmark.version,
      contractVersion: benchmark.contractVersion,
      mode: "practice",
      status: "queued",
      branch: options.branch || (options.exactSha ? "detached" : actor.team.defaultBranch),
      sha,
      repositoryId: actor.team.repoId,
      parentRunId: null,
      attemptNumber: null,
      failureCategory: null,
      failurePhase: null,
      failureDetail: null,
      failureConsumedAttempt: false,
      log: null,
      createdAt: now,
      finishedAt: null,
      provider: env.EXECUTION_PROVIDER,
      protocolVersion: "1",
      preparedArtifactId: null,
      environmentDigest: null,
      datasetVersion: "practice-v1",
      scorerVersion: benchmark.scorerVersion,
      runtimeVersion: benchmark.runtimeVersion,
      dispatchAttempts: 0,
      lastEventSequence: -1,
      surfaceId,
    });
  } catch (error) {
    const [existing] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.surfaceId, surfaceId), eq(runs.mode, "practice")))
      .limit(1);
    if (existing) return { runId: existing.id, surfaceId };
    // The partial unique index resolves concurrent starts as a normal conflict.
    if (isUniqueConstraintError(error)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    throw error;
  }
  await insertPhaseSkeleton(env, runId);
  await dispatch(env, runId, actor.team, benchmark);
  await publishRunSurface(env, surfaceId);
  return { runId, surfaceId };
}

export async function promotePracticeRun(
  env: Env,
  actor: RunActor,
  practiceRunId: string,
): Promise<{ runId: string; surfaceId: string }> {
  await requireCurrentRepositoryPermission(env, actor);
  const db = getDb(env);
  const [parentRow] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, practiceRunId), eq(runs.teamId, actor.team.id)))
    .limit(1);
  if (!parentRow) throw new ApiHttpError(404, "not_found", "Run not found.");
  const parent = await syncRun(db, parentRow);
  if (parent.mode !== "practice" || parent.status !== "succeeded" || !parent.surfaceId) {
    throw new ApiHttpError(409, "not_promotable", "Only a succeeded hosted run can be promoted.");
  }
  const [existing] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.surfaceId, parent.surfaceId), eq(runs.mode, "official")))
    .limit(1);
  if (existing) return existingOfficialPromotion(existing, parent.surfaceId);
  const benchmark = await activeBenchmark(env, parent.benchmarkId, parent.benchmarkVersion);
  const teamRuns = await syncTeamRuns(db, actor.team.id, parent.benchmarkId);
  if (hasActive(teamRuns)) throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
  const claims = await db
    .select()
    .from(officialAttempts)
    .where(
      and(
        eq(officialAttempts.teamId, actor.team.id),
        eq(officialAttempts.benchmarkId, parent.benchmarkId),
        eq(officialAttempts.benchmarkVersion, parent.benchmarkVersion),
      ),
    );
  if (claims.length >= OFFICIAL_LIMIT) throw new ApiHttpError(409, "quota_exhausted", "The official-attempt quota is exhausted.");
  if (env.EXECUTION_PROVIDER === "modal") {
    assertModalConfigured(env);
    if (!parent.preparedArtifactId) {
      throw new ApiHttpError(409, "not_promotable", "The prepared hosted artifact is unavailable. Verify the commit again.");
    }
  }
  const runId = `run_${randomHex(5)}`;
  const now = Date.now();
  const attemptNumber = claims.length + 1;
  try {
    await db.insert(runs).values({
      ...parent,
      id: runId,
      mode: "official",
      status: "queued",
      parentRunId: parent.id,
      attemptNumber,
      failureCategory: null,
      failurePhase: null,
      failureDetail: null,
      failureConsumedAttempt: false,
      log: null,
      createdAt: now,
      finishedAt: null,
      datasetVersion: benchmark.datasetVersion,
      scorerVersion: benchmark.scorerVersion,
      runtimeVersion: benchmark.runtimeVersion,
      dispatchAttempts: 0,
      lastEventSequence: -1,
      surfaceId: parent.surfaceId,
    });
    await db.insert(officialAttempts).values({
      id: newId("attempt_"),
      teamId: actor.team.id,
      benchmarkId: parent.benchmarkId,
      benchmarkVersion: parent.benchmarkVersion,
      runId,
      attemptNumber,
      consumed: false,
      claimedAt: now,
    });
  } catch {
    await db.delete(runs).where(eq(runs.id, runId));
    const [raced] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.surfaceId, parent.surfaceId), eq(runs.mode, "official")))
      .limit(1);
    if (raced) return existingOfficialPromotion(raced, parent.surfaceId);
    throw new ApiHttpError(409, "quota_exhausted", "The official attempt could not be claimed.");
  }
  await insertPhaseSkeleton(env, runId);
  await dispatch(env, runId, actor.team, benchmark);
  await publishRunSurface(env, parent.surfaceId);
  return { runId, surfaceId: parent.surfaceId };
}

export async function publishOfficialRun(env: Env, actor: RunActor, runId: string) {
  await requireCurrentRepositoryPermission(env, actor);
  const db = getDb(env);
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.teamId, actor.team.id)))
    .limit(1);
  if (!row) throw new ApiHttpError(404, "not_found", "Run not found.");
  const run = await syncRun(db, row);
  if (run.mode !== "official" || run.status !== "succeeded") {
    throw new ApiHttpError(409, "not_selectable", "Only a succeeded official run can be published.");
  }
  await db
    .insert(leaderboardSelections)
    .values({
      teamId: actor.team.id,
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
  if (run.surfaceId) await publishRunSurface(env, run.surfaceId);
  return { ok: true as const, surfaceId: run.surfaceId };
}

export async function rerunHostedSurface(env: Env, actor: RunActor, surfaceId: string) {
  const successorId = `surface_${(await sha256Hex(`rerun:${surfaceId}`)).slice(0, 20)}`;
  const [practice] = await getDb(env)
    .select()
    .from(runs)
    .where(and(eq(runs.surfaceId, surfaceId), eq(runs.mode, "practice"), eq(runs.teamId, actor.team.id)))
    .limit(1);
  if (!practice) throw new ApiHttpError(404, "not_found", "Hosted run not found.");
  return startPracticeRun(env, actor, {
    benchmarkId: practice.benchmarkId,
    branch: practice.branch === "detached" ? null : practice.branch,
    exactSha: practice.sha,
    surfaceId: successorId,
    supersedesSurfaceId: surfaceId,
  });
}

export type RunSurfaceMutation =
  | "verify_hosted"
  | "promote_official"
  | "publish_result"
  | "rerun_hosted";

/** Shared mutation boundary for Portal HTTP, the Activity, and CogBot RPC.
 * Every caller supplies a freshly resolved actor; eligibility rendered in a
 * previous snapshot is never trusted. */
export async function performRunSurfaceMutation(
  env: Env,
  actor: RunActor,
  surfaceId: string,
  action: RunSurfaceMutation,
) {
  const surface = await getDb(env)
    .select()
    .from(runSurfaces)
    .where(and(eq(runSurfaces.id, surfaceId), eq(runSurfaces.teamId, actor.team.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!surface) throw new ApiHttpError(404, "not_found", "Run surface not found.");

  if (action === "verify_hosted") {
    if (!surface.localRunId) {
      throw new ApiHttpError(409, "not_promotable", "This surface did not start locally.");
    }
    const [local] = await getDb(env)
      .select()
      .from(localRunSessions)
      .where(eq(localRunSessions.id, surface.localRunId))
      .limit(1);
    if (!local || local.status !== "succeeded") {
      throw new ApiHttpError(409, "not_promotable", "Finish the local run before verifying it.");
    }
    if (local.dirty) {
      throw new ApiHttpError(409, "not_promotable", "Commit your changes before hosted verification.");
    }
    await startPracticeRun(env, actor, {
      benchmarkId: local.benchmarkId,
      branch: local.branch,
      exactSha: local.sha,
      surfaceId,
    });
    return publishRunSurface(env, surfaceId);
  }

  const snapshot = await publishRunSurface(env, surfaceId);
  if (action === "promote_official") {
    if (!snapshot.practiceRunId) {
      throw new ApiHttpError(409, "not_promotable", "Verify this run first.");
    }
    await promotePracticeRun(env, actor, snapshot.practiceRunId);
    return publishRunSurface(env, surfaceId);
  }
  if (action === "publish_result") {
    if (!snapshot.officialRunId) {
      throw new ApiHttpError(409, "not_selectable", "No official result is ready.");
    }
    await publishOfficialRun(env, actor, snapshot.officialRunId);
    return publishRunSurface(env, surfaceId);
  }

  const rerun = await rerunHostedSurface(env, actor, surfaceId);
  return publishRunSurface(env, rerun.surfaceId);
}
