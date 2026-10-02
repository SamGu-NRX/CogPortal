import { and, asc, desc, eq, exists, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import {
  MetricSchema,
  OFFICIAL_LIMIT,
  PRACTICE_LIMIT,
  RUN_PHASES,
  RunStreamEventSchema,
  RunSurfaceSnapshotSchema,
  runSource,
  type Metric,
  type RunStreamEvent,
  type RunStreamEventCode,
  type RunSurfaceAction,
  type RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import { accountLogin } from "../auth/session";
import { runSourceRefusal } from "./run-source";
import { getDb, type Database } from "../db/client";
import { insertWhere } from "../db/insert-where";
import type { Env } from "../env";
import {
  benchmarks,
  leaderboardSelections,
  localReports,
  localRunSessions,
  runMetrics,
  runPhases,
  runs,
  runStreamEvents,
  runSurfaces,
  teams,
  users,
  type BenchmarkRow,
  type RunRow,
  type RunSurfaceRow,
} from "../db/schema";
import { syncRun } from "../execution/sync";
import { validateRetryInputs } from "../execution/runner";
import { serializeMetric } from "../http/serializers";
import { ApiHttpError } from "../http/errors";
import {
  canPublishOfficialRun,
  currentSurfaceRun,
  fixtureRetryRefusal,
  officialPromotionRefusal,
  rankingRefusal,
} from "./run-eligibility";
import { acceptedRunPredicate, readRunAccounting } from "./run-accounting";

const MAX_SURFACE_EVENTS = 250;

/**
 * How long a running local session may go without an event before the portal
 * says it has lost contact. The CLI heartbeats every two seconds, but its
 * sender is serial and gives up on one event only after three 15-second
 * attempts (python/cogbench/src/cogbench/client.py), so a slow portal alone
 * can open a gap of about 46 seconds. Two minutes clears that; no measured
 * distribution of real gaps backs the exact figure.
 */
const LOCAL_SILENCE_MS = 2 * 60 * 1000;

function sharedStatus(status: string): RunSurfaceSnapshot["status"] {
  if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
  return "running";
}

function localCode(phase: string): RunStreamEventCode {
  const codes: Record<string, RunStreamEventCode> = {
    preparing: "repository.ready",
    contract_check: "contract.checking",
    evaluating: "evaluation.started",
    scoring: "scoring.started",
  };
  return codes[phase] ?? "evaluation.progress";
}

export function runnerFailureCode(category: string): RunStreamEventCode {
  const codes: Record<string, RunStreamEventCode> = {
    repository_fetch: "run.failed.repository",
    dependency_install: "run.failed.dependencies",
    adapter_missing: "run.failed.contract",
    contract_invalid: "run.failed.contract",
    student_runtime: "run.failed.runtime",
    timeout: "run.failed.timeout",
    memory_limit: "run.failed.memory",
    output_invalid: "run.failed.output",
    scorer: "run.failed.scorer",
    provider: "run.failed.provider",
  };
  return codes[category] ?? "run.failed.provider";
}

function streamEvent(row: typeof runStreamEvents.$inferSelect): RunStreamEvent | null {
  const parsed = RunStreamEventSchema.safeParse({
    eventId: row.eventId,
    source: row.source,
    sourceRunId: row.sourceRunId,
    sourceSequence: row.sourceSequence,
    phase: row.phase,
    code: row.code,
    occurredAt: row.occurredAt,
    elapsedMs: row.elapsedMs,
    progress:
      row.progressCurrent != null && row.progressTotal != null && row.progressUnit
        ? { current: row.progressCurrent, total: row.progressTotal, unit: row.progressUnit }
        : null,
  });
  return parsed.success ? parsed.data : null;
}

const FIXTURE_PHASE_CODES: Record<(typeof RUN_PHASES)[number], RunStreamEventCode> = {
  queued: "repository.fetching",
  preparing: "repository.fetching",
  installing: "dependencies.installing",
  contract_check: "contract.checking",
  evaluating: "evaluation.started",
  scoring: "scoring.started",
};

/** The fixture provider advances from wall-clock time instead of runner
 * callbacks. Materialize the same safe event contract used by Modal so the
 * realtime UI exercises the real projection path without inventing case
 * counts or exposing synthetic stdout. */
async function syncFixtureStreamEvents(
  env: Env,
  surfaceId: string,
  run: RunRow,
): Promise<void> {
  if (run.provider !== "fixture") return;
  const db = getDb(env);
  const phases = await db.select().from(runPhases).where(eq(runPhases.runId, run.id));
  const phaseByName = new Map(phases.map((phase) => [phase.phase, phase]));
  const values: Array<typeof runStreamEvents.$inferInsert> = [];
  const add = (
    sourceSequence: number,
    phase: string,
    code: RunStreamEventCode,
    occurredAt: number,
  ) => {
    values.push({
      eventId: `fixtureevent_${run.id}_${sourceSequence}`,
      surfaceId,
      source: run.mode,
      sourceRunId: run.id,
      sourceSequence,
      phase,
      code,
      elapsedMs: Math.max(0, occurredAt - run.createdAt),
      progressCurrent: null,
      progressTotal: null,
      progressUnit: null,
      occurredAt,
    });
  };

  RUN_PHASES.forEach((phase, index) => {
    const timing = phaseByName.get(phase);
    if (!timing?.startedAt) return;
    // Queued and preparing are one user-visible repository-fetch step. Keep
    // the first timestamp instead of rendering two identical lines.
    if (phase === "preparing") return;
    add(index * 2, phase, FIXTURE_PHASE_CODES[phase], timing.startedAt);
    const failedHere = run.status === "failed" && run.failurePhase === phase;
    if (phase === "contract_check" && timing.endedAt && !failedHere) {
      add(index * 2 + 1, phase, "contract.passed", timing.endedAt);
    }
  });

  if (run.finishedAt && run.status === "succeeded") {
    add(RUN_PHASES.length * 2 + 1, "scoring", "run.completed", run.finishedAt);
  } else if (run.finishedAt && run.status === "failed") {
    add(
      RUN_PHASES.length * 2 + 1,
      run.failurePhase ?? "queued",
      runnerFailureCode(run.failureCategory ?? "provider"),
      run.finishedAt,
    );
  }

  if (!values.length) return;
  const existing = new Set(
    (await db
      .select({ eventId: runStreamEvents.eventId })
      .from(runStreamEvents)
      .where(and(eq(runStreamEvents.surfaceId, surfaceId), eq(runStreamEvents.sourceRunId, run.id))))
      .map((event) => event.eventId),
  );
  const missing = values.filter((event) => !existing.has(event.eventId));
  if (!missing.length) return;
  await db.insert(runStreamEvents).values(missing).onConflictDoNothing();
  await db.update(runSurfaces).set({ updatedAt: Date.now() }).where(eq(runSurfaces.id, surfaceId));
}

async function metricsForRun(env: Env, runId: string): Promise<Metric[]> {
  const rows = await getDb(env).select().from(runMetrics).where(eq(runMetrics.runId, runId));
  return rows.map(serializeMetric).sort((a, b) => Number(b.primary) - Number(a.primary));
}

async function metricsForLocal(env: Env, reportId: string | null): Promise<Metric[]> {
  if (!reportId) return [];
  const [row] = await getDb(env)
    .select({ metricsJson: localReports.metricsJson })
    .from(localReports)
    .where(eq(localReports.reportId, reportId))
    .limit(1);
  if (!row) return [];
  try {
    return MetricSchema.array()
      .parse(JSON.parse(row.metricsJson))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  } catch {
    return [];
  }
}

/**
 * The team's best hosted or official reading on the measure the board ranks,
 * under the current scorer, excluding this surface. A run's own primary flag
 * would mix measures: a partial Language run flags text MRR, and its 0.4 is
 * not better or worse than another run's overall.
 */
async function teamBestMetric(
  env: Env,
  teamId: string,
  benchmark: Pick<BenchmarkRow, "id" | "version" | "scorerVersion" | "primaryMetricKey">,
  excludeSurfaceId: string,
): Promise<Metric | null> {
  const rows = await getDb(env)
    .select({ metric: runMetrics })
    .from(runMetrics)
    .innerJoin(runs, eq(runMetrics.runId, runs.id))
    .where(
      and(
        eq(runs.teamId, teamId),
        eq(runs.benchmarkId, benchmark.id),
        eq(runs.benchmarkVersion, benchmark.version),
        eq(runs.scorerVersion, benchmark.scorerVersion),
        acceptedRunPredicate(),
        eq(runMetrics.key, benchmark.primaryMetricKey),
        // SQL `NULL != value` is unknown, so include legacy successful runs
        // that predate run surfaces as well as runs on a different surface.
        or(isNull(runs.surfaceId), ne(runs.surfaceId, excludeSurfaceId)),
      ),
    );
  const metrics = rows.map((row) => ({ ...serializeMetric(row.metric), primary: true }));
  // Same key and scorer with two directions has no "best"; say nothing
  // rather than pick one. The leaderboard refuses the same state loudly.
  if (new Set(metrics.map((metric) => metric.higherIsBetter)).size > 1) {
    console.error(`Team best for ${benchmark.id}@${benchmark.version}: "${benchmark.primaryMetricKey}" has conflicting directions.`);
    return null;
  }
  let best: Metric | null = null;
  for (const metric of metrics) {
    if (!best || (metric.higherIsBetter ? metric.value > best.value : metric.value < best.value)) {
      best = metric;
    }
  }
  return best;
}

export async function getRunSurfaceRow(env: Env, surfaceId: string): Promise<RunSurfaceRow> {
  const [surface] = await getDb(env)
    .select()
    .from(runSurfaces)
    .where(eq(runSurfaces.id, surfaceId))
    .limit(1);
  if (!surface) throw new ApiHttpError(404, "not_found", "Run surface not found.");
  return surface;
}

/** Internal DO read only. These separate DB reads and wall-clock elapsed time
 * are eventually consistent, not a point-in-time database transaction. */
export async function readRunSurfaceSnapshot(
  env: Env,
  surfaceId: string,
): Promise<RunSurfaceSnapshot> {
  const db = getDb(env);
  const surface = await getRunSurfaceRow(env, surfaceId);
  const [[team], [benchmark], [actor], localRows, attachedRows] = await Promise.all([
    db.select().from(teams).where(eq(teams.id, surface.teamId)).limit(1),
    db
      .select()
      .from(benchmarks)
      .where(
        and(
          eq(benchmarks.id, surface.benchmarkId),
          eq(benchmarks.version, surface.benchmarkVersion),
        ),
      )
      .limit(1),
    db.select().from(users).where(eq(users.id, surface.createdByUserId)).limit(1),
    surface.localRunId
      ? db.select().from(localRunSessions).where(eq(localRunSessions.id, surface.localRunId)).limit(1)
      : Promise.resolve([]),
    db.select().from(runs).where(eq(runs.surfaceId, surface.id)).orderBy(asc(runs.createdAt)),
  ]);
  if (!team || !benchmark || !actor) {
    throw new ApiHttpError(404, "not_found", "Run surface context no longer exists.");
  }

  const syncedRuns = await Promise.all(attachedRows.map((row) => syncRun(db, row)));
  await Promise.all(syncedRuns.map((run) => syncFixtureStreamEvents(env, surface.id, run)));
  const eventRows = await db
    .select()
    .from(runStreamEvents)
    .where(eq(runStreamEvents.surfaceId, surface.id))
    .orderBy(desc(runStreamEvents.occurredAt), desc(runStreamEvents.sourceSequence))
    .limit(MAX_SURFACE_EVENTS);
  const practice = currentSurfaceRun(syncedRuns, "practice");
  const official = currentSurfaceRun(syncedRuns, "official");
  const local = localRows[0] ?? null;
  const selected = official
    ? await db
        .select({ runId: leaderboardSelections.runId })
        .from(leaderboardSelections)
        .where(
          and(
            eq(leaderboardSelections.teamId, surface.teamId),
            eq(leaderboardSelections.benchmarkId, surface.benchmarkId),
            eq(leaderboardSelections.benchmarkVersion, surface.benchmarkVersion),
            eq(leaderboardSelections.runId, official.id),
          ),
        )
        .limit(1)
    : [];
  const metrics = official
    ? await metricsForRun(env, official.id)
    : practice
      ? await metricsForRun(env, practice.id)
      : await metricsForLocal(env, local?.reportId ?? null);
  // Set for a run the board leaves out, so a stored selection of it is not
  // called published and Publish is not offered for it.
  const publicationRefusal = official ? rankingRefusal(official, benchmark, metrics) : null;
  const published = selected.length > 0 && official !== null && publicationRefusal === null;
  const stage = published ? "published" : official ? "official" : practice ? "hosted" : "local";
  const current: RunRow | typeof local = official ?? practice ?? local;
  if (!current) throw new ApiHttpError(404, "not_found", "Run surface has no run.");
  const status = sharedStatus(current.status);
  const createdAt = current.createdAt;
  const finishedAt = current.finishedAt;
  const now = Date.now();
  // The row stays running, so a late heartbeat or completed report is
  // accepted as usual and clears this.
  const silentSince = stage === "local" && local?.status === "running"
    && now - local.updatedAt >= LOCAL_SILENCE_MS
    ? local.updatedAt
    : null;
  const elapsedMs = Math.max(0, (finishedAt ?? silentSince ?? now) - createdAt);
  const events = eventRows.map(streamEvent).filter((item): item is RunStreamEvent => item !== null).reverse();
  const currentEvents = events.filter((event) => event.sourceRunId === current.id);
  const databasePhase = stage === "local" ? local?.phase ?? current.status : current.status;
  const phase = status === "running" ? currentEvents.at(-1)?.phase ?? databasePhase : databasePhase;
  const latestProgress = [...currentEvents].reverse().find((event) => event.progress)?.progress ?? null;
  const primaryMetric = metrics.find((item) => item.primary) ?? null;
  // The best is under the current scorer, so a run scored by an older one
  // has nothing comparable to sit against.
  const scoredRun = official ?? practice;
  const teamBest = scoredRun && scoredRun.scorerVersion !== benchmark.scorerVersion
    ? null
    : await teamBestMetric(env, surface.teamId, benchmark, surface.id);

  // What this surface's work ran from, and whether that still is the team's
  // repository. The server refuses these actions either way; offering a
  // control that will be refused is the part this removes.
  //
  // Hosted verification is governed by the local session's source, because it
  // resolves that session's commit against the connected repository. The other
  // three are governed by the hosted run's.
  const sourceRun = official ?? practice ?? null;
  const source = runSource(current.repositoryFullName);
  const hostedRefusal = sourceRun ? runSourceRefusal(team, sourceRun, "act on it") : null;
  const localRefusal = local ? runSourceRefusal(team, local, "verify it here") : null;
  const sourceRefusal = stage === "local" ? localRefusal : hostedRefusal;

  // Separate from the source refusal above: this one is about whether the
  // benchmark's official dataset is approved and the artifact the practice run
  // saved can still be reused, not about which repository the run came from.
  const promotionBlocked = practice && env.EXECUTION_PROVIDER === "modal"
    ? officialPromotionRefusal(practice, benchmark, team)
    : null;
  const promotionRefusal = stage === "hosted" && status === "succeeded" ? promotionBlocked : null;
  const actions: RunSurfaceAction[] = ["open_console", "open_portal"];
  // A silent run may never report again, so the way forward is offered now.
  if (stage === "local" && (status !== "running" || silentSince !== null)) {
    actions.push("run_again");
    if (status === "succeeded" && !local?.dirty && !localRefusal) {
      actions.splice(2, 0, "verify_hosted");
    }
  } else if (stage === "hosted" && status !== "running") {
    if (!hostedRefusal) {
      actions.push("rerun_hosted");
      if (status === "succeeded" && practice?.refundedAt === null && promotionBlocked === null) {
        actions.splice(2, 0, "promote_official");
      }
    }
  } else if (stage === "official" && official && !hostedRefusal) {
    if (publicationRefusal === null) actions.push("publish_result");
    // Failed executions and historical refunds cannot be promoted again here.
    if (status === "failed" || (status !== "running" && official.refundedAt !== null)) actions.push("rerun_hosted");
  }

  const accounting = await readRunAccounting(db, {
    teamId: surface.teamId, benchmarkId: surface.benchmarkId, benchmarkVersion: surface.benchmarkVersion,
  });
  const occupied = accounting.officialUsed + accounting.officialReserved;
  const nextAttempt = occupied < OFFICIAL_LIMIT ? occupied + 1 : null;
  const execution = official ?? practice;
  // Each provider's own admission check, so neither advertises a Retry the
  // server would refuse. A fixture has no recorded job to validate.
  let retryRefusal: string | null = null;
  if (execution?.status === "failed") {
    if (execution.provider === "modal") {
      try {
        validateRetryInputs(env, execution, team, benchmark);
      } catch (error) {
        if (!(error instanceof ApiHttpError) || error.status !== 409) throw error;
        retryRefusal = error.message;
      }
    } else {
      retryRefusal = fixtureRetryRefusal(execution, benchmark);
    }
  }
  const retryCapacity = execution?.mode === "official"
    ? occupied < OFFICIAL_LIMIT
    : accounting.practiceUsed + accounting.practiceReserved < PRACTICE_LIMIT;
  if (execution?.status === "failed" && benchmark.active && !accounting.activeRuns
    && retryCapacity && execution.provider === env.EXECUTION_PROVIDER
    && !hostedRefusal
    && execution.repositoryId !== null && execution.repositoryId === team.repoId
    && retryRefusal === null) {
    actions.splice(2, 0, "retry");
  }

  return RunSurfaceSnapshotSchema.parse({
    id: surface.id,
    team: { id: team.id, name: team.name },
    benchmark: { id: benchmark.id, version: benchmark.version, title: benchmark.title },
    actor: { login: accountLogin(actor), name: actor.name },
    // Source and commit identify the same stage as its status and metrics.
    sha: current.sha,
    shortSha: current.sha.slice(0, 7),
    branch: current.branch,
    source,
    sourceRefusal,
    dirty: local?.dirty ?? false,
    stage,
    status,
    phase,
    createdAt,
    updatedAt: surface.updatedAt,
    finishedAt,
    silentSince,
    elapsedMs,
    progress: latestProgress,
    primaryMetric,
    metrics,
    teamBest,
    localRunId: local?.id ?? null,
    practiceRunId: practice?.id ?? null,
    officialRunId: official?.id ?? null,
    executionGeneration: syncedRuns.length,
    executionHistory: syncedRuns.map((run) => ({
      id: run.id,
      mode: run.mode,
      status: run.status,
      retryOfRunId: run.retryOfRunId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    })),
    published,
    nextOfficialAttempt: nextAttempt,
    // The run that failed, if one did. A refusal explains itself; every other
    // failure has a traceback and belongs in the log rather than in a chat
    // message.
    refusalHeadline: refusalHeadlineOf(official ?? practice),
    promotionRefusal,
    // Only where Publish would otherwise be: an official run that finished
    // and could be published but for what the board ranks.
    publicationRefusal: stage === "official" && official && canPublishOfficialRun(official) && !hostedRefusal
      ? publicationRefusal : null,
    retryRefusal,
    events,
    actions,
    simulated: env.EXECUTION_PROVIDER === "fixture",
  });
}

function refusalHeadlineOf(run: { refusalJson?: string | null } | null | undefined): string | null {
  if (!run?.refusalJson) return null;
  try {
    const parsed = JSON.parse(run.refusalJson) as { headline?: unknown };
    // Drift insurance between the independently capped refusal and snapshot schemas:
    // preserve the sentence up to this boundary rather than reject the whole snapshot.
    // Discord applies its own 300-character cap in discord-messages.ts.
    return typeof parsed.headline === "string" && parsed.headline ? parsed.headline.slice(0, 600) : null;
  } catch {
    return null;
  }
}

function streamEventRow(surfaceId: string, event: RunStreamEvent): typeof runStreamEvents.$inferInsert {
  const parsed = RunStreamEventSchema.parse(event);
  return {
    eventId: parsed.eventId,
    surfaceId,
    source: parsed.source,
    sourceRunId: parsed.sourceRunId,
    sourceSequence: parsed.sourceSequence,
    phase: parsed.phase,
    code: parsed.code,
    elapsedMs: parsed.elapsedMs,
    progressCurrent: parsed.progress?.current ?? null,
    progressTotal: parsed.progress?.total ?? null,
    progressUnit: parsed.progress?.unit ?? null,
    occurredAt: parsed.occurredAt,
  };
}

/** A stream event written only if `condition` holds when it runs, for a batch
 *  that must record the event together with the state change it reports. An
 *  event that collides with a stored one fails the batch rather than letting
 *  the state change commit without it. */
export function guardedRunStreamEventInsert(
  db: Database,
  surfaceId: string,
  event: RunStreamEvent,
  condition: SQL,
) {
  return insertWhere(db, runStreamEvents, streamEventRow(surfaceId, event), condition);
}

/** After a new event: move the console up its team's list, and keep only its
 *  newest MAX_SURFACE_EVENTS. */
export async function settleRunStreamEvents(db: Database, surfaceId: string): Promise<void> {
  await db.update(runSurfaces).set({ updatedAt: Date.now() }).where(eq(runSurfaces.id, surfaceId));
  const overflow = await db
    .select({ eventId: runStreamEvents.eventId })
    .from(runStreamEvents)
    .where(eq(runStreamEvents.surfaceId, surfaceId))
    .orderBy(desc(runStreamEvents.occurredAt))
    .limit(1_000)
    .offset(MAX_SURFACE_EVENTS);
  if (overflow.length) {
    await db.delete(runStreamEvents).where(inArray(runStreamEvents.eventId, overflow.map((row) => row.eventId)));
  }
}

export async function appendRunStreamEvent(
  env: Env,
  surfaceId: string,
  event: RunStreamEvent,
  options: { publish?: boolean } = {},
) {
  const db = getDb(env);
  const result = await db.insert(runStreamEvents).values(streamEventRow(surfaceId, event)).onConflictDoNothing();
  const duplicate = (result.meta.changes ?? 0) === 0;
  if (!duplicate) await settleRunStreamEvents(db, surfaceId);
  if (options.publish !== false) await publishRunSurface(env, surfaceId);
  return { duplicate };
}

async function requestRunSurfaceSnapshot(
  env: Env,
  surfaceId: string,
  operation: "snapshot" | "publish",
): Promise<RunSurfaceSnapshot> {
  const stub = env.RUN_SURFACES.get(env.RUN_SURFACES.idFromName(surfaceId));
  const response = await stub.fetch(`https://run-surface.internal/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ surfaceId }),
  });
  if (response.status === 404) throw new ApiHttpError(404, "not_found", await response.text());
  if (!response.ok) throw new Error("The realtime run surface could not be updated.");
  const snapshot = RunSurfaceSnapshotSchema.parse(await response.json());
  if (snapshot.id !== surfaceId || snapshot.snapshotRevision === 0) {
    throw new Error("The realtime run surface returned an unstamped or mismatched snapshot.");
  }
  return snapshot;
}

export async function buildRunSurfaceSnapshot(env: Env, surfaceId: string): Promise<RunSurfaceSnapshot> {
  return requestRunSurfaceSnapshot(env, surfaceId, "snapshot");
}

export async function publishRunSurface(env: Env, surfaceId: string): Promise<RunSurfaceSnapshot> {
  return requestRunSurfaceSnapshot(env, surfaceId, "publish");
}

/** How many consoles the team's list shows. */
const LISTED_SURFACES = 10;

/**
 * The team's newest consoles, for the portal and Activity lists.
 *
 * Only consoles with something to show are selected, before the limit, so a
 * console with no run and no local session (left by an older start that was
 * refused) can neither fail the list nor push real consoles out of it. A 404
 * from one snapshot means its context vanished after the selection, and that
 * console is left out; any other failure still fails the list.
 */
export async function listTeamRunSurfaceSnapshots(env: Env, teamId: string): Promise<RunSurfaceSnapshot[]> {
  const db = getDb(env);
  const rows = await db
    .select({ id: runSurfaces.id })
    .from(runSurfaces)
    .where(and(
      eq(runSurfaces.teamId, teamId),
      or(
        // Every run chain on a console starts with a run that is not a retry,
        // so this is "has any run", phrased so runs_surface_mode_unique applies.
        exists(db.select({ id: runs.id }).from(runs).where(and(
          eq(runs.surfaceId, runSurfaces.id), isNull(runs.retryOfRunId),
        ))),
        exists(db.select({ id: localRunSessions.id }).from(localRunSessions)
          .where(eq(localRunSessions.id, runSurfaces.localRunId))),
      ),
    ))
    .orderBy(desc(runSurfaces.updatedAt))
    .limit(LISTED_SURFACES);
  const snapshots = await Promise.all(rows.map(async ({ id }) => {
    try {
      return await buildRunSurfaceSnapshot(env, id);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 404) return null;
      throw error;
    }
  }));
  return snapshots.filter((snapshot) => snapshot !== null);
}

export function defaultLocalEventCode(phase: string): RunStreamEventCode {
  return localCode(phase);
}
