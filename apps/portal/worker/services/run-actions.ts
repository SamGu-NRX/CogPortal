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
import { getDb, type Database } from "../db/client";
import {
  benchmarks,
  discordAccounts,
  leaderboardSelections,
  localRunSessions,
  runMetrics,
  runPhases,
  runs,
  runSurfaces,
  teamMembers,
  teams,
  users,
  type BenchmarkRow,
  type TeamRow,
} from "../db/schema";
import { syncRun, syncTeamRuns } from "../execution/sync";
import { DispatchUnacknowledged, assertModalConfigured, enqueueRun, prepareAdmissionJob, prepareRetryJob, type DispatchInputs } from "../execution/runner";
import { FixtureGitHubClient, GitHubApiError, RealGitHubClient } from "../github/client";
import { ApiHttpError, GITHUB_SIGN_IN_EXPIRED } from "../http/errors";
import { runSourceRefusal } from "./run-source";
import { randomHex } from "../util/id";
import { sha256Hex } from "../util/crypto";
import { publishRunSurface } from "./run-surfaces";
import {
  currentSurfaceRun,
  existingPromotion,
  failureAllowsRetry,
  fixtureRetryRefusal,
  NO_CONSOLE_PROMOTION_REFUSAL,
  type ExistingPromotion,
  rankingRefusal,
  runStateRefusal,
  savedEnvironmentEligibility,
} from "./run-eligibility";
import { actorOnTeam, insertRunWithCapacity, isAdmittingMember, readRunAccounting } from "./run-accounting";
import { insertWhere } from "../db/insert-where";
import { teamMemberUserIds } from "./local-reports";

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

/**
 * `requireTeam` resolves the team when the request arrives, and an admin can
 * change the repository between then and the write. Re-reading narrows that
 * window for both the permission check and the source rule, which previously
 * both trusted the same snapshot. It does not close it: D1 has no interactive
 * transaction, so a switch landing between this read and the write still wins.
 * That is the pre-existing model for the permission check, and this at least
 * stops the two disagreeing with the row they are about to write against.
 */
async function withCurrentTeam(env: Env, actor: RunActor): Promise<RunActor> {
  const [team] = await getDb(env)
    .select()
    .from(teams)
    .where(eq(teams.id, actor.team.id))
    .limit(1);
  return team ? { ...actor, team } : actor;
}

function requireRunSource(
  actor: RunActor,
  source: { repositoryId: number | null } | null | undefined,
  action: string,
): void {
  const refusal = runSourceRefusal(actor.team, source, action);
  if (refusal) throw new ApiHttpError(409, "source_changed", refusal);
}

/*
 * A quota refusal reaches a student who just pressed a button, often in
 * Discord where the page's own "N of 10 left" line is not in view, so it says
 * what is used up and what is still open to them. The Runs and run pages say
 * the same things before the button is pressed (DashboardPage.tsx,
 * RunDetailPage.tsx). A succeeded attempt is not always publishable
 * (publishOfficialRun also refuses a refunded attempt, one from a former
 * repository, outdated scoring rules or a missing primary metric), so the
 * official refusal points at the run page, which says which, instead of
 * promising publication.
 */
export const PRACTICE_QUOTA_REFUSAL =
  `All ${PRACTICE_LIMIT} hosted practice runs on this version are used. Local runs (cogworks run) have no limit.`;
export const OFFICIAL_QUOTA_REFUSAL =
  `All ${OFFICIAL_LIMIT} official attempts on this version are used. An official attempt that already succeeded may still be publishable; its run page says whether it is.`;

const WRITE_PERMISSION_REQUIRED =
  "Current write permission to the connected repository is required.";

/**
 * The refusal for a write-access lookup that GitHub did not answer with a
 * permission. Only a 401 means the sign-in expired. GitHub answers 403 or 404
 * to an account that can no longer see the repository's collaborators, and
 * anything else (a 5xx, a rate limit, a dropped connection, a malformed body)
 * says nothing about the student, so telling them to sign in again would send
 * them somewhere that cannot help. The last one says only that the action did
 * not happen: some callers republish the run surface before this check
 * (`performRunSurfaceMutation`), so "nothing changed" would claim more than
 * this path knows.
 *
 * 403 for the expired sign-in rather than 401: the Activity reads a 401 as its
 * own session ending (lib/activity-gate.ts) and would ask the student to
 * reopen it.
 */
export function permissionCheckFailure(error: unknown): ApiHttpError {
  if (error instanceof GitHubApiError && error.status === 401) {
    return new ApiHttpError(403, "forbidden", GITHUB_SIGN_IN_EXPIRED);
  }
  if (error instanceof GitHubApiError && !error.rateLimited && (error.status === 403 || error.status === 404)) {
    return new ApiHttpError(403, "forbidden", WRITE_PERMISSION_REQUIRED);
  }
  return new ApiHttpError(
    502,
    "provider_unconfigured",
    "GitHub didn't answer the write-access check, so this didn't go through. Try again in a moment.",
  );
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
  } catch (error) {
    throw permissionCheckFailure(error);
  }
  if (!["admin", "maintain", "write", "push"].includes(permission)) {
    throw new ApiHttpError(403, "forbidden", WRITE_PERMISSION_REQUIRED);
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

/** A repeated promotion returns the attempt it already started, spending nothing. */
function repeatPromotion(promotion: ExistingPromotion, surfaceId: string) {
  if (promotion.refusal) throw new ApiHttpError(409, "not_promotable", promotion.refusal);
  return { runId: promotion.promotedTo.runId, surfaceId };
}

/** Every new execution starts with no runner activity and no rollout grace,
 *  never a parent's: promotion copies the parent row, and the stale-run sweep
 *  would otherwise judge the new execution by the old one's silence. */
const NEW_EXECUTION_ACTIVITY = { acceptedActivityAt: null, legacyGraceUntil: 0 } as const;

/** Phase rows for a run admitted earlier in the same batch. A refused capacity
 *  insert leaves the run absent, so these write nothing either. */
function guardedPhaseInserts(db: Database, runId: string) {
  return RUN_PHASES.map((phase) => db.insert(runPhases).select(sql`
    select ${runId}, ${phase}, null, null
    where exists (select 1 from ${runs} where ${runs.id} = ${runId})
  `));
}

async function dispatch(env: Env, runId: string, team: TeamRow) {
  if (env.EXECUTION_PROVIDER !== "modal") return;
  const [run] = await getDb(env).select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new ApiHttpError(500, "provider_unconfigured", "Run could not be loaded.");
  try {
    await enqueueRun(env, run, team);
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

/**
 * Republish a console after this request's write has committed.
 *
 * Callers pass an ApiHttpError straight to the student as a refusal (the RPC
 * entrypoint, worker/rpc.ts, and the HTTP error mapper). Once the run, the
 * promotion or the leaderboard selection is written, a 404 or 409 from the
 * republish would tell them the action was refused when it went through.
 * Anything thrown here is therefore a plain Error: the bot answers it with
 * "It may still have gone through", and the original stays in the log.
 */
async function republishAfterCommit<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new Error(
      `The write committed, then republishing the run surface failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/** A run refused because its starter is no longer on the team. */
const LEFT_TEAM_ADMISSION = "You're no longer on this team, so no run was started. Reload to see where you are.";
const LEFT_TEAM_PUBLICATION = "You're no longer on this team, so nothing was published. Reload to see where you are.";

/**
 * The roster a Modal run's inputs are prepared from, read once, with the
 * actor checked against it before any report or weight object is read. The
 * guarded INSERT still decides admission; this keeps a departure during
 * preparation from becoming an empty manifest under a second roster read.
 */
async function admissionRoster(env: Env, actor: RunActor): Promise<string[]> {
  const members = await teamMemberUserIds(env, actor.team.id);
  if (!members.includes(actor.userId)) throw new ApiHttpError(403, "forbidden", LEFT_TEAM_ADMISSION);
  return members;
}

/** An admission INSERT changed nothing: say which condition failed. */
async function refusedAdmission(db: Database, actor: RunActor, quotaRefusal: string): Promise<never> {
  if (!(await isAdmittingMember(db, actor.team.id, actor.userId))) {
    throw new ApiHttpError(403, "forbidden", LEFT_TEAM_ADMISSION);
  }
  throw new ApiHttpError(409, "quota_exhausted", quotaRefusal);
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
    throw new ApiHttpError(409, "quota_exhausted", PRACTICE_QUOTA_REFUSAL);
  }
  if (env.EXECUTION_PROVIDER === "modal") {
    assertModalConfigured(env);
    // A contract transition pauses admission before creating a failed execution.
    if (benchmark.sandboxContract == null || !Number.isSafeInteger(benchmark.sandboxContract) || benchmark.sandboxContract <= 0) {
      throw new ApiHttpError(409, "not_promotable", "This benchmark's hosted environment is not ready.");
    }
  }

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
  const runId = `run_${randomHex(5)}`;
  const dispatchInputs: DispatchInputs = {
    id: runId,
    mode: "practice",
    sha,
    repositoryId: actor.team.repoId,
    // Read from the same team snapshot as the id above, so the two always
    // describe one repository. Promotion inherits both by spreading the
    // parent run, which is what keeps an official attempt pointing at the
    // repository its practice run used.
    repositoryFullName: actor.team.repoFullName,
    benchmarkId: benchmark.id,
    benchmarkVersion: benchmark.version,
    contractVersion: benchmark.contractVersion,
    datasetVersion: "practice-v1",
    scorerVersion: benchmark.scorerVersion,
    protocolVersion: "1",
    provider: env.EXECUTION_PROVIDER,
    preparedArtifactId: null,
    preparedEnvironmentJson: null,
  };
  // A Modal run is born with the job it will be sent with (prepareAdmissionJob).
  // A refusal here (weights, provenance, a departed starter) writes nothing.
  const job = env.EXECUTION_PROVIDER === "modal"
    ? await prepareAdmissionJob(env, dispatchInputs, actor.team, benchmark, await admissionRoster(env, actor))
    : null;
  try {
    const insertRun = insertRunWithCapacity(db, {
      ...dispatchInputs,
      teamId: actor.team.id,
      status: "queued",
      branch: options.branch || (options.exactSha ? "detached" : actor.team.defaultBranch),
      parentRunId: null,
      attemptNumber: null,
      failureCategory: null,
      failurePhase: null,
      failureDetail: null,
      failureConsumedAttempt: false,
      log: null,
      createdAt: now,
      finishedAt: null,
      environmentDigest: null,
      runtimeVersion: benchmark.runtimeVersion,
      dispatchJobJson: job ? JSON.stringify(job) : null,
      dispatchAttempts: 0,
      lastEventSequence: -1,
      ...NEW_EXECUTION_ACTIVITY,
      surfaceId,
    }, actor.userId);
    // One D1 batch is one transaction: the console is written only if this
    // run was admitted, because a console with no run cannot be rendered. An
    // existing console (a local session being verified, a replayed rerun) is
    // left exactly as it was.
    const insertSurface = db
      .insert(runSurfaces)
      .select(
        // Drizzle requires every column, in table order.
        db
          .select({
            id: sql<string>`${surfaceId}`.as("id"),
            teamId: runs.teamId,
            createdByUserId: sql<string>`${actor.userId}`.as("createdByUserId"),
            benchmarkId: runs.benchmarkId,
            benchmarkVersion: runs.benchmarkVersion,
            localRunId: sql<null>`null`.as("localRunId"),
            supersedesSurfaceId: sql<string | null>`${options.supersedesSurfaceId ?? null}`.as("supersedesSurfaceId"),
            discordChannelId: sql<string | null>`${actor.team.discordChannelId}`.as("discordChannelId"),
            discordMessageId: sql<null>`null`.as("discordMessageId"),
            discordNonceGeneration: sql<number>`0`.as("discordNonceGeneration"),
            createdAt: sql<number>`${now}`.as("createdAt"),
            updatedAt: sql<number>`${now}`.as("updatedAt"),
          })
          .from(runs)
          .where(eq(runs.id, runId)),
      )
      .onConflictDoNothing();
    const [inserted] = await db.batch([insertRun, insertSurface, ...guardedPhaseInserts(db, runId)]);
    if (!inserted.meta.changes) await refusedAdmission(db, actor, PRACTICE_QUOTA_REFUSAL);
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
  await dispatch(env, runId, actor.team);
  await republishAfterCommit(publishRunSurface(env, surfaceId));
  return { runId, surfaceId };
}

export async function promotePracticeRun(
  env: Env,
  actor: RunActor,
  practiceRunId: string,
): Promise<{ runId: string; surfaceId: string }> {
  actor = await withCurrentTeam(env, actor);
  await requireCurrentRepositoryPermission(env, actor);
  const db = getDb(env);
  const [parentRow] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, practiceRunId), eq(runs.teamId, actor.team.id)))
    .limit(1);
  if (!parentRow) throw new ApiHttpError(404, "not_found", "Run not found.");
  const parent = await syncRun(db, parentRow);
  if (parent.mode !== "practice" || parent.status !== "succeeded" || parent.refundedAt !== null) {
    throw new ApiHttpError(409, "not_promotable", "Only a succeeded hosted run can be promoted.");
  }
  if (!parent.surfaceId) throw new ApiHttpError(409, "not_promotable", NO_CONSOLE_PROMOTION_REFUSAL);
  // Before any attempt is claimed: an official attempt is a claim about the
  // connected repository, and this run may not be from it.
  requireRunSource(actor, parent, "promote it");
  const attached = await db.select().from(runs).where(eq(runs.surfaceId, parent.surfaceId));
  const existing = existingPromotion(attached);
  if (existing) return repeatPromotion(existing, parent.surfaceId);
  const benchmark = await activeBenchmark(env, parent.benchmarkId, parent.benchmarkVersion);
  if (env.EXECUTION_PROVIDER === "modal") {
    const eligibility = savedEnvironmentEligibility(parent, benchmark, actor.team);
    if (!eligibility.eligible) throw new ApiHttpError(409, "not_promotable", eligibility.reason);
  }
  await syncTeamRuns(db, actor.team.id, parent.benchmarkId);
  const scope = { teamId: actor.team.id, benchmarkId: parent.benchmarkId, benchmarkVersion: parent.benchmarkVersion };
  const accounting = await readRunAccounting(db, scope);
  if (accounting.activeRuns) throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
  if (accounting.officialUsed + accounting.officialReserved >= OFFICIAL_LIMIT) {
    throw new ApiHttpError(409, "quota_exhausted", OFFICIAL_QUOTA_REFUSAL);
  }
  if (env.EXECUTION_PROVIDER === "modal") {
    assertModalConfigured(env);
  }
  const runId = `run_${randomHex(5)}`;
  const now = Date.now();
  // The attempt carries the practice run's source and saved environment; only
  // its identity, mode and the official dataset and scorer differ.
  const proposed = {
    ...parent,
    id: runId,
    mode: "official" as const,
    datasetVersion: benchmark.datasetVersion,
    scorerVersion: benchmark.scorerVersion,
  };
  // Born with its job, built from that saved environment (prepareAdmissionJob).
  const job = env.EXECUTION_PROVIDER === "modal"
    ? await prepareAdmissionJob(env, proposed, actor.team, benchmark, await admissionRoster(env, actor))
    : null;
  try {
    const insertRun = insertRunWithCapacity(db, {
      ...proposed,
      status: "queued",
      parentRunId: parent.id,
      retryOfRunId: null,
      dispatchJobJson: job ? JSON.stringify(job) : null,
      failureCategory: null,
      failurePhase: null,
      failureDetail: null,
      failureConsumedAttempt: false,
      log: null,
      createdAt: now,
      finishedAt: null,
      runtimeVersion: benchmark.runtimeVersion,
      dispatchAttempts: 0,
      lastEventSequence: -1,
      ...NEW_EXECUTION_ACTIVITY,
      surfaceId: parent.surfaceId,
    }, actor.userId);
    // A phase-write failure must not leave an admitted run without its phases.
    const [inserted] = await db.batch([insertRun, ...guardedPhaseInserts(db, runId)]);
    if (!inserted.meta.changes) await refusedAdmission(db, actor, OFFICIAL_QUOTA_REFUSAL);
  } catch (error) {
    const attached = await db.select().from(runs).where(eq(runs.surfaceId, parent.surfaceId));
    const raced = existingPromotion(attached);
    if (raced) return repeatPromotion(raced, parent.surfaceId);
    if (error instanceof ApiHttpError) throw error;
    if (isUniqueConstraintError(error)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    throw error;
  }
  await dispatch(env, runId, actor.team);
  await republishAfterCommit(publishRunSurface(env, parent.surfaceId));
  return { runId, surfaceId: parent.surfaceId };
}

export async function publishOfficialRun(env: Env, actor: RunActor, runId: string) {
  actor = await withCurrentTeam(env, actor);
  await requireCurrentRepositoryPermission(env, actor);
  const db = getDb(env);
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.teamId, actor.team.id)))
    .limit(1);
  if (!row) throw new ApiHttpError(404, "not_found", "Run not found.");
  const run = await syncRun(db, row);
  // The run's own state answers before its source does, and the source
  // before the catalog and metric checks below.
  const stateRefusal = runStateRefusal(run);
  if (stateRefusal) throw new ApiHttpError(409, "not_selectable", stateRefusal);
  // A published result is the team's public claim about its connected
  // repository. An existing selection is left alone; this refuses a new one.
  requireRunSource(actor, run, "publish a result");
  const [benchmark] = await db
    .select({ scorerVersion: benchmarks.scorerVersion, primaryMetricKey: benchmarks.primaryMetricKey })
    .from(benchmarks)
    .where(and(eq(benchmarks.id, run.benchmarkId), eq(benchmarks.version, run.benchmarkVersion)))
    .limit(1);
  const metrics = await db.select({ key: runMetrics.key }).from(runMetrics).where(eq(runMetrics.runId, run.id));
  // Refused before the write, so the team's current selection stays as it was.
  const refusal = rankingRefusal(run, benchmark, metrics);
  if (refusal) throw new ApiHttpError(409, "not_selectable", refusal);
  // The checks above awaited GitHub and the provider, and the actor can leave
  // the team meanwhile. Membership is checked again by the write itself: when
  // the SELECT yields no row there is nothing to insert or to conflict, so
  // the guard covers a first publication and a replaced one alike.
  const selectedAt = Date.now();
  const selected = await insertWhere(db, leaderboardSelections, {
    teamId: actor.team.id,
    benchmarkId: run.benchmarkId,
    benchmarkVersion: run.benchmarkVersion,
    runId: run.id,
    selectedAt,
  }, actorOnTeam(db, actor.team.id, actor.userId))
    .onConflictDoUpdate({
      target: [
        leaderboardSelections.teamId,
        leaderboardSelections.benchmarkId,
        leaderboardSelections.benchmarkVersion,
      ],
      set: { runId: run.id, selectedAt },
    });
  if (!selected.meta.changes) throw new ApiHttpError(403, "forbidden", LEFT_TEAM_PUBLICATION);
  // Query after the selection write: a prior-selection read can miss a
  // concurrent switch and leave the deselected console showing Published.
  const affected = await db.selectDistinct({ surfaceId: runs.surfaceId }).from(runs).where(and(
    eq(runs.teamId, run.teamId),
    eq(runs.benchmarkId, run.benchmarkId),
    eq(runs.benchmarkVersion, run.benchmarkVersion),
    eq(runs.mode, "official"),
  ));
  await republishAfterCommit(
    Promise.all(affected.flatMap(({ surfaceId }) => surfaceId ? [publishRunSurface(env, surfaceId)] : [])),
  );
  return { ok: true as const, surfaceId: run.surfaceId };
}

export async function rerunHostedSurface(env: Env, actor: RunActor, surfaceId: string) {
  actor = await withCurrentTeam(env, actor);
  const successorId = `surface_${(await sha256Hex(`rerun:${surfaceId}`)).slice(0, 20)}`;
  const attached = await getDb(env).select().from(runs)
    .where(and(eq(runs.surfaceId, surfaceId), eq(runs.teamId, actor.team.id)));
  const practice = currentSurfaceRun(attached, "practice");
  if (!practice) throw new ApiHttpError(404, "not_found", "Hosted run not found.");
  // A rerun resolves the old commit against the connected repository, which is
  // a different repository's commit unless this run came from it.
  requireRunSource(actor, practice, "run it again");
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
  actor = await withCurrentTeam(env, actor);
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
  if (!failureAllowsRetry(failed)) {
    throw new ApiHttpError(409, "invalid_request",
      "Retry isn't available for this failure. Check the diagnostics, fix the cause, then start a new run.");
  }
  const attached = await db.select().from(runs).where(eq(runs.surfaceId, surfaceId));
  const current = currentSurfaceRun(attached, "official") ?? currentSurfaceRun(attached, "practice");
  if (current?.id !== failed.id) {
    if ((await successor()).length) return;
    throw new ApiHttpError(409, "invalid_request", "Retry the current failed execution from its console.");
  }
  if (failed.provider !== env.EXECUTION_PROVIDER || failed.repositoryId === null || failed.repositoryId !== actor.team.repoId) {
    throw new ApiHttpError(409, "invalid_request", "The recorded execution source is no longer available. Start a new candidate.");
  }
  const benchmark = await activeBenchmark(env, failed.benchmarkId, failed.benchmarkVersion);
  // Modal's recorded-input check in prepareRetryJob owns these comparisons.
  const fixtureRefusal = fixtureRetryRefusal(failed, benchmark);
  if (fixtureRefusal) throw new ApiHttpError(409, "invalid_request", fixtureRefusal);
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
    throw new ApiHttpError(409, "quota_exhausted",
      failed.mode === "official" ? OFFICIAL_QUOTA_REFUSAL : PRACTICE_QUOTA_REFUSAL);
  }
  const runId = `run_${randomHex(5)}`;
  const job = failed.provider === "modal"
    ? await prepareRetryJob(env, failed, actor.team, benchmark, runId)
    : null;
  const now = Date.now();
  // Only the dispatch record says whether the failed execution reused a saved
  // artifact or prepared its own; a late completion can leave a different id
  // on the row (validateRetryInputs). Reusing that exact artifact reuses its
  // weights, so the record of which weights it holds comes along. A fresh
  // prepare starts with none recorded, and its completion reports what it used.
  const preparedArtifactId = job ? job.preparedArtifactId : failed.preparedArtifactId;
  const sameArtifact = preparedArtifactId !== null && preparedArtifactId === failed.preparedArtifactId;
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
    repositoryFullName: failed.repositoryFullName,
    parentRunId: failed.parentRunId,
    retryOfRunId: failed.id,
    dispatchJobJson: job ? JSON.stringify(job) : null,
    provider: failed.provider,
    protocolVersion: failed.protocolVersion,
    preparedArtifactId,
    preparedEnvironmentJson: job?.preparedEnvironment ? JSON.stringify(job.preparedEnvironment) : null,
    ...(sameArtifact ? { weightsSuppliedJson: failed.weightsSuppliedJson } : {}),
    datasetVersion: failed.datasetVersion,
    scorerVersion: failed.scorerVersion,
    runtimeVersion: failed.runtimeVersion,
    ...NEW_EXECUTION_ACTIVITY,
    surfaceId,
    createdAt: now,
  }, actor.userId);
  const updateSurface = db.update(runSurfaces).set({ updatedAt: now }).where(and(
    eq(runSurfaces.id, surfaceId),
    exists(db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId))),
  ));
  try {
    const [inserted] = await db.batch([insertRun, ...guardedPhaseInserts(db, runId), updateSurface]);
    if (!inserted.meta.changes) {
      await refusedAdmission(db, actor, failed.mode === "official" ? OFFICIAL_QUOTA_REFUSAL : PRACTICE_QUOTA_REFUSAL);
    }
  } catch (error) {
    if ((await successor()).length) return;
    if (isUniqueConstraintError(error)) {
      throw new ApiHttpError(409, "active_run_exists", "A run is already active for this benchmark.");
    }
    throw error;
  }
  await dispatch(env, runId, actor.team);
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
  actor = await withCurrentTeam(env, actor);
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
    return republishAfterCommit(publishRunSurface(env, surfaceId));
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
    // Hosted verification resolves this session's commit against the connected
    // repository, so it is a rerun by another name and needs the same rule. A
    // session recorded before the team moved is about the old repository.
    requireRunSource(actor, local, "verify it here");
    await startPracticeRun(env, actor, {
      benchmarkId: local.benchmarkId,
      branch: local.branch,
      exactSha: local.sha,
      surfaceId,
    });
    return republishAfterCommit(publishRunSurface(env, surfaceId));
  }

  // Eligibility before publication. `publishRunSurface` writes a snapshot to
  // the realtime hub and can wake a Discord update, so refusing after it means
  // a rejected request still had an observable effect.
  const [surfacePractice] = await getDb(env)
    .select({ repositoryId: runs.repositoryId })
    .from(runs)
    .where(and(eq(runs.surfaceId, surfaceId), eq(runs.mode, "practice")))
    .limit(1);
  const [surfaceOfficial] = await getDb(env)
    .select({ repositoryId: runs.repositoryId })
    .from(runs)
    .where(and(eq(runs.surfaceId, surfaceId), eq(runs.mode, "official")))
    .limit(1);
  if (action === "promote_official" || action === "rerun_hosted") {
    if (!surfacePractice) {
      if (action === "rerun_hosted") throw new ApiHttpError(404, "not_found", "Hosted run not found.");
      throw new ApiHttpError(409, "not_promotable", "Verify this run first.");
    }
    requireRunSource(actor, surfacePractice, "act on it");
  } else if (action === "publish_result") {
    if (!surfaceOfficial) throw new ApiHttpError(409, "not_selectable", "No official result is ready.");
    requireRunSource(actor, surfaceOfficial, "publish a result");
  }

  const snapshot = await publishRunSurface(env, surfaceId);
  if (action === "promote_official") {
    if (!snapshot.practiceRunId) {
      throw new ApiHttpError(409, "not_promotable", "Verify this run first.");
    }
    await promotePracticeRun(env, actor, snapshot.practiceRunId);
    return republishAfterCommit(publishRunSurface(env, surfaceId));
  }
  if (action === "publish_result") {
    if (!snapshot.officialRunId) {
      throw new ApiHttpError(409, "not_selectable", "No official result is ready.");
    }
    await publishOfficialRun(env, actor, snapshot.officialRunId);
    return republishAfterCommit(publishRunSurface(env, surfaceId));
  }

  const rerun = await rerunHostedSurface(env, actor, surfaceId);
  return republishAfterCommit(publishRunSurface(env, rerun.surfaceId));
}
