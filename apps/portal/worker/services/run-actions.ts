import { and, desc, eq, exists, sql } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  OFFICIAL_LIMIT,
  PRACTICE_LIMIT,
  RUN_PHASES,
  RetryRunRequestSchema,
  type RetryRunRequest,
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
import { DispatchUnacknowledged, assertModalConfigured, enqueueRun, prepareRetryJob } from "../execution/runner";
import { FixtureGitHubClient, RealGitHubClient } from "../github/client";
import { ApiHttpError } from "../http/errors";
import { randomHex } from "../util/id";
import { sha256Hex } from "../util/crypto";
import { publishRunSurface } from "./run-surfaces";
import { canPublishOfficialRun, currentSurfaceRun } from "./run-eligibility";
import { insertRunWithCapacity, readRunAccounting } from "./run-accounting";

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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

function existingOfficialPromotion(run: RunRow, surfaceId: string) {
  if (run.status === "failed" || run.refundedAt !== null) {
    throw new ApiHttpError(
      409,
      "not_promotable",
      run.status === "failed"
        ? "That official attempt already ran and failed. Start a new practice run to create the next candidate to promote."
        : "That official attempt was refunded. Start a new practice run to create the next candidate to promote.",
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
  } catch (error) {
    if (error instanceof DispatchUnacknowledged) {
      // submit_job spawns before replying. Keep the active reservation until
      // a callback or the stale-run reaper resolves uncertain acceptance.
      console.warn(JSON.stringify({ evt: "dispatch_unacknowledged", runId }));
      return;
    }
    // Everything else happened before anything was sent, or carries Modal's
    // own refusal, so the run never started and saying so at once is right.
    //
    // Callback progress is the evidence that the job was accepted: the first
    // runner event moves the status off `queued` and raises lastEventSequence
    // above its -1 default. So the repair carries that condition, and how many
    // rows it changed is the answer to whether the run had started.
    //
    // Fail only an unstarted execution so a callback wins safely.
    const db = getDb(env);
    const unstarted = and(
      eq(runs.id, runId),
      eq(runs.status, "queued"),
      eq(runs.lastEventSequence, -1),
    );
    // Weight validation provides a safe resync instruction. Keep it in both
    // the failed run and the response rather than suggesting a blind retry.
    const inputError = error instanceof ApiHttpError && error.code === "invalid_request"
      ? error
      : null;
    const failRun = db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: Date.now(),
        failureCategory: "provider",
        failurePhase: "queued",
        failureDetail: inputError?.message ?? "The run could not be queued for Modal.",
      })
      .where(unstarted);
    const changed = (await failRun).meta.changes ?? 0;
    // Nothing was still waiting to start, so a callback got here first and
    // Modal has the job. Nothing above matched, so nothing was changed; leave
    // the run alone and let the run page follow it.
    if (changed === 0) return;
    if (inputError) throw inputError;
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
    const attached = await db.select().from(runs).where(eq(runs.surfaceId, options.surfaceId));
    const existing = currentSurfaceRun(attached, "practice");
    if (existing) return { runId: existing.id, surfaceId: options.surfaceId };
  }
  await syncTeamRuns(db, actor.team.id, benchmark.id);
  const accounting = await readRunAccounting(db, {
    teamId: actor.team.id, benchmarkId: benchmark.id, benchmarkVersion: benchmark.version,
  });
  if (accounting.activeRuns) throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
  if (accounting.practiceUsed + accounting.practiceReserved >= PRACTICE_LIMIT) {
    throw new ApiHttpError(409, "quota_exhausted", "The practice-run quota is exhausted.");
  }
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
    const inserted = await insertRunWithCapacity(db, {
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
    if (!inserted.meta.changes) throw new ApiHttpError(409, "quota_exhausted", "The practice-run quota is exhausted.");
  } catch (error) {
    const attached = await db.select().from(runs).where(eq(runs.surfaceId, surfaceId));
    const existing = currentSurfaceRun(attached, "practice");
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
  if (parent.mode !== "practice" || parent.status !== "succeeded" || parent.refundedAt !== null || !parent.surfaceId) {
    throw new ApiHttpError(409, "not_promotable", "Only a succeeded hosted run can be promoted.");
  }
  const attached = await db.select().from(runs).where(eq(runs.surfaceId, parent.surfaceId));
  const existing = currentSurfaceRun(attached, "official");
  if (existing) return existingOfficialPromotion(existing, parent.surfaceId);
  const benchmark = await activeBenchmark(env, parent.benchmarkId, parent.benchmarkVersion);
  await syncTeamRuns(db, actor.team.id, parent.benchmarkId);
  const scope = { teamId: actor.team.id, benchmarkId: parent.benchmarkId, benchmarkVersion: parent.benchmarkVersion };
  const accounting = await readRunAccounting(db, scope);
  if (accounting.activeRuns) throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
  if (accounting.officialUsed + accounting.officialReserved >= OFFICIAL_LIMIT) {
    throw new ApiHttpError(409, "quota_exhausted", "The official-attempt quota is exhausted.");
  }
  if (env.EXECUTION_PROVIDER === "modal") {
    assertModalConfigured(env);
    if (!parent.preparedArtifactId) {
      throw new ApiHttpError(409, "not_promotable", "The prepared hosted artifact is unavailable. Verify the commit again.");
    }
  }
  const runId = `run_${randomHex(5)}`;
  const now = Date.now();
  try {
    const insertRun = insertRunWithCapacity(db, {
      ...parent,
      id: runId,
      mode: "official",
      status: "queued",
      parentRunId: parent.id,
      retryOfRunId: null,
      dispatchJobJson: null,
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
    // A phase-write failure must not leave an admitted run without its phases.
    // A rejected capacity insert creates no phases.
    const insertPhases = RUN_PHASES.map((phase) => db.insert(runPhases).select(sql`
      select ${runId}, ${phase}, null, null
      where exists (select 1 from ${runs} where ${runs.id} = ${runId})
    `));
    const [inserted] = await db.batch([insertRun, ...insertPhases]);
    if (!inserted.meta.changes) throw new ApiHttpError(409, "quota_exhausted", "The official-attempt quota is exhausted.");
  } catch (error) {
    const attached = await db.select().from(runs).where(eq(runs.surfaceId, parent.surfaceId));
    const raced = currentSurfaceRun(attached, "official");
    if (raced) return existingOfficialPromotion(raced, parent.surfaceId);
    if (error instanceof ApiHttpError) throw error;
    if (isUniqueConstraintError(error)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    throw error;
  }
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
  if (!canPublishOfficialRun(run)) {
    throw new ApiHttpError(409, "not_selectable", run.refundedAt !== null
      ? "This attempt was refunded, so its findings can't be published. Choose another official run."
      : "Only a succeeded official run can be published.");
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
  const attached = await getDb(env).select().from(runs)
    .where(and(eq(runs.surfaceId, surfaceId), eq(runs.teamId, actor.team.id)));
  const practice = currentSurfaceRun(attached, "practice");
  if (!practice) throw new ApiHttpError(404, "not_found", "Hosted run not found.");
  return startPracticeRun(env, actor, {
    benchmarkId: practice.benchmarkId,
    branch: practice.branch === "detached" ? null : practice.branch,
    exactSha: practice.sha,
    surfaceId: successorId,
    supersedesSurfaceId: surfaceId,
  });
}

export async function retryRun(
  env: Env,
  actor: RunActor,
  surfaceId: string,
  failedRunId: string,
): Promise<void> {
  const db = getDb(env);
  const [failed] = await db.select().from(runs).where(and(
    eq(runs.id, failedRunId), eq(runs.surfaceId, surfaceId), eq(runs.teamId, actor.team.id),
  )).limit(1);
  if (!failed) throw new ApiHttpError(404, "not_found", "Run not found.");
  const githubToken = await requireCurrentRepositoryPermission(env, actor);
  if (failed.status !== "failed") {
    throw new ApiHttpError(409, "invalid_request", "Only a failed execution can be retried.");
  }
  const successor = () => db.select().from(runs).where(eq(runs.retryOfRunId, failed.id)).limit(1);
  // A replay stays bound to this failure even if its successor has also failed.
  if ((await successor()).length) return;
  const attached = await db.select().from(runs).where(eq(runs.surfaceId, surfaceId));
  const current = currentSurfaceRun(attached, "official") ?? currentSurfaceRun(attached, "practice");
  if (current?.id !== failed.id) {
    if ((await successor()).length) return;
    throw new ApiHttpError(409, "invalid_request", "Retry the current failed execution from its console.");
  }
  if (failed.provider !== env.EXECUTION_PROVIDER || failed.repositoryId !== actor.team.repoId) {
    throw new ApiHttpError(409, "invalid_request", "The recorded execution source is no longer available. Start a new candidate.");
  }
  const benchmark = await activeBenchmark(env, failed.benchmarkId, failed.benchmarkVersion);
  if (failed.contractVersion !== benchmark.contractVersion
    || failed.scorerVersion !== benchmark.scorerVersion
    || failed.runtimeVersion !== benchmark.runtimeVersion
    || failed.datasetVersion !== (failed.mode === "official" ? benchmark.datasetVersion : "practice-v1")) {
    throw new ApiHttpError(409, "invalid_request", "The recorded benchmark configuration has changed. Start a new candidate.");
  }
  if (actor.team.repoFullName !== FIXTURE_REPO.fullName) {
    if (!githubToken) throw new ApiHttpError(403, "forbidden", "Sign in to GitHub on Cog*Portal first.");
    try {
      const github = new RealGitHubClient();
      const repository = await github.getRepo(actor.team.repoFullName, githubToken);
      if (repository.id !== failed.repositoryId || repository.private) {
        throw new Error("Recorded repository unavailable to the runner");
      }
      const sha = await github.resolveRef(actor.team.repoOwner, actor.team.repoName, failed.sha, githubToken);
      if (sha !== failed.sha) throw new Error("Commit changed");
    } catch {
      throw new ApiHttpError(409, "invalid_request", "The runner can't read the recorded repository and commit. Restore access before Retry.");
    }
  }
  await syncTeamRuns(db, actor.team.id, failed.benchmarkId);
  const scope = { teamId: actor.team.id, benchmarkId: failed.benchmarkId, benchmarkVersion: failed.benchmarkVersion };
  const accounting = await readRunAccounting(db, scope);
  if (accounting.activeRuns) {
    if ((await successor()).length) return;
    throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
  }
  const occupied = failed.mode === "official"
    ? accounting.officialUsed + accounting.officialReserved
    : accounting.practiceUsed + accounting.practiceReserved;
  if (occupied >= (failed.mode === "official" ? OFFICIAL_LIMIT : PRACTICE_LIMIT)) {
    if ((await successor()).length) return;
    throw new ApiHttpError(409, "quota_exhausted", "The completed-evaluation quota is exhausted.");
  }
  const runId = `run_${randomHex(5)}`;
  const job = failed.provider === "modal"
    ? await prepareRetryJob(env, failed, actor.team, benchmark, runId)
    : null;
  const now = Date.now();
  const insertRun = insertRunWithCapacity(db, {
    id: runId,
    teamId: failed.teamId,
    benchmarkId: failed.benchmarkId,
    benchmarkVersion: failed.benchmarkVersion,
    contractVersion: failed.contractVersion,
    mode: failed.mode,
    status: "queued",
    branch: failed.branch,
    sha: failed.sha,
    repositoryId: failed.repositoryId,
    parentRunId: failed.parentRunId,
    retryOfRunId: failed.id,
    dispatchJobJson: job ? JSON.stringify(job) : null,
    provider: failed.provider,
    protocolVersion: failed.protocolVersion,
    preparedArtifactId: job ? job.preparedArtifactId : failed.preparedArtifactId,
    datasetVersion: failed.datasetVersion,
    scorerVersion: failed.scorerVersion,
    runtimeVersion: failed.runtimeVersion,
    surfaceId,
    createdAt: now,
  });
  const insertPhases = RUN_PHASES.map((phase) => db.insert(runPhases).select(sql`
    select ${runId}, ${phase}, null, null
    where exists (select 1 from ${runs} where ${runs.id} = ${runId})
  `));
  const updateSurface = db.update(runSurfaces).set({ updatedAt: now }).where(and(
    eq(runSurfaces.id, surfaceId),
    exists(db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId))),
  ));
  try {
    const [inserted] = await db.batch([insertRun, ...insertPhases, updateSurface]);
    if (!inserted.meta.changes) {
      throw new ApiHttpError(409, "quota_exhausted",
        failed.mode === "official" ? "The official-attempt quota is exhausted." : "The practice-run quota is exhausted.");
    }
  } catch (error) {
    if ((await successor()).length) return;
    if (isUniqueConstraintError(error)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    throw error;
  }
  await dispatch(env, runId, actor.team, benchmark);
}

export type RunSurfaceMutation =
  | "verify_hosted"
  | "promote_official"
  | "publish_result"
  | "rerun_hosted"
  | "retry";

/** Shared mutation boundary for Portal HTTP, the Activity, and CogBot RPC.
 * Every caller supplies a freshly resolved actor; eligibility rendered in a
 * previous snapshot is never trusted. */
export async function performRunSurfaceMutation(
  env: Env,
  actor: RunActor,
  surfaceId: string,
  action: RunSurfaceMutation,
  request?: RetryRunRequest,
) {
  const surface = await getDb(env)
    .select()
    .from(runSurfaces)
    .where(and(eq(runSurfaces.id, surfaceId), eq(runSurfaces.teamId, actor.team.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!surface) throw new ApiHttpError(404, "not_found", "Run surface not found.");

  if (action === "retry") {
    const { runId } = RetryRunRequestSchema.parse(request);
    await retryRun(env, actor, surfaceId, runId);
    return publishRunSurface(env, surfaceId);
  }

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
