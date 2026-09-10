import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  MetricSchema,
  OFFICIAL_LIMIT,
  RUN_PHASES,
  RunStreamEventSchema,
  RunSurfaceSnapshotSchema,
  type Metric,
  type RunStreamEvent,
  type RunStreamEventCode,
  type RunSurfaceAction,
  type RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import { accountLogin } from "../auth/session";
import { getDb } from "../db/client";
import type { Env } from "../env";
import {
  benchmarks,
  leaderboardSelections,
  localReports,
  localRunSessions,
  officialAttempts,
  runMetrics,
  runPhases,
  runs,
  runStreamEvents,
  runSurfaces,
  teams,
  users,
  type RunRow,
  type RunSurfaceRow,
} from "../db/schema";
import { syncRun } from "../execution/sync";
import { serializeMetric } from "../http/serializers";
import { ApiHttpError } from "../http/errors";

const MAX_SURFACE_EVENTS = 250;

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

/** Best hosted or official primary metric, excluding this surface. */
async function teamBestMetric(
  env: Env,
  teamId: string,
  benchmarkId: string,
  benchmarkVersion: number,
  excludeSurfaceId: string,
): Promise<Metric | null> {
  const rows = await getDb(env)
    .select({ metric: runMetrics })
    .from(runMetrics)
    .innerJoin(runs, eq(runMetrics.runId, runs.id))
    .where(
      and(
        eq(runs.teamId, teamId),
        eq(runs.benchmarkId, benchmarkId),
        eq(runs.benchmarkVersion, benchmarkVersion),
        eq(runs.status, "succeeded"),
        eq(runMetrics.isPrimary, true),
        // SQL `NULL != value` is unknown, so include legacy successful runs
        // that predate run surfaces as well as runs on a different surface.
        or(isNull(runs.surfaceId), ne(runs.surfaceId, excludeSurfaceId)),
      ),
    );
  let best: Metric | null = null;
  for (const row of rows) {
    const metric = serializeMetric(row.metric);
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

export async function buildRunSurfaceSnapshot(
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
  const practice = syncedRuns.find((row) => row.mode === "practice") ?? null;
  const official = syncedRuns.find((row) => row.mode === "official") ?? null;
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
  const published = selected.length > 0;
  const stage = published ? "published" : official ? "official" : practice ? "hosted" : "local";
  const current: RunRow | typeof local = official ?? practice ?? local;
  if (!current) throw new ApiHttpError(404, "not_found", "Run surface has no run.");
  const status = sharedStatus(current.status);
  const createdAt = current.createdAt;
  const finishedAt = current.finishedAt;
  const now = Date.now();
  const elapsedMs = Math.max(0, (finishedAt ?? now) - createdAt);
  const events = eventRows.map(streamEvent).filter((item): item is RunStreamEvent => item !== null).reverse();
  const currentEvents = events.filter((event) => event.sourceRunId === current.id);
  const databasePhase = stage === "local" ? local?.phase ?? current.status : current.status;
  const phase = status === "running" ? currentEvents.at(-1)?.phase ?? databasePhase : databasePhase;
  const latestProgress = [...currentEvents].reverse().find((event) => event.progress)?.progress ?? null;
  const metrics = official
    ? await metricsForRun(env, official.id)
    : practice
      ? await metricsForRun(env, practice.id)
      : await metricsForLocal(env, local?.reportId ?? null);
  const primaryMetric = metrics.find((item) => item.primary) ?? null;
  const teamBest = await teamBestMetric(
    env,
    surface.teamId,
    surface.benchmarkId,
    surface.benchmarkVersion,
    surface.id,
  );

  const actions: RunSurfaceAction[] = ["open_console", "open_portal"];
  if (stage === "local" && status !== "running") {
    actions.push("run_again");
    if (status === "succeeded" && !local?.dirty) actions.splice(2, 0, "verify_hosted");
  } else if (stage === "hosted" && status !== "running") {
    actions.push("rerun_hosted");
    if (status === "succeeded") actions.splice(2, 0, "promote_official");
  } else if (stage === "official" && status === "succeeded") {
    actions.push("publish_result");
  }

  const claims = await db
    .select({ id: officialAttempts.id })
    .from(officialAttempts)
    .where(
      and(
        eq(officialAttempts.teamId, surface.teamId),
        eq(officialAttempts.benchmarkId, surface.benchmarkId),
        eq(officialAttempts.benchmarkVersion, surface.benchmarkVersion),
      ),
    );
  const nextAttempt = claims.length < OFFICIAL_LIMIT ? claims.length + 1 : null;

  return RunSurfaceSnapshotSchema.parse({
    id: surface.id,
    team: { id: team.id, name: team.name },
    benchmark: { id: benchmark.id, version: benchmark.version, title: benchmark.title },
    actor: { login: accountLogin(actor), name: actor.name },
    sha: local?.sha ?? practice?.sha ?? official?.sha,
    shortSha: (local?.sha ?? practice?.sha ?? official?.sha ?? "").slice(0, 7),
    branch: local?.branch ?? practice?.branch ?? official?.branch ?? null,
    dirty: local?.dirty ?? false,
    stage,
    status,
    phase,
    createdAt,
    updatedAt: surface.updatedAt,
    finishedAt,
    elapsedMs,
    progress: latestProgress,
    primaryMetric,
    metrics,
    teamBest,
    localRunId: local?.id ?? null,
    practiceRunId: practice?.id ?? null,
    officialRunId: official?.id ?? null,
    published,
    nextOfficialAttempt: nextAttempt,
    // The run that failed, if one did. A refusal explains itself; every other
    // failure has a traceback and belongs in the log rather than in a chat
    // message.
    refusalHeadline: refusalHeadlineOf(official ?? practice),
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

export async function appendRunStreamEvent(
  env: Env,
  surfaceId: string,
  event: RunStreamEvent,
  options: { publish?: boolean } = {},
) {
  const parsed = RunStreamEventSchema.parse(event);
  const db = getDb(env);
  const result = await db
    .insert(runStreamEvents)
    .values({
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
    })
    .onConflictDoNothing();
  const duplicate = (result.meta.changes ?? 0) === 0;
  if (!duplicate) {
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
  if (options.publish !== false) await publishRunSurface(env, surfaceId);
  return { duplicate };
}

export async function publishRunSurface(env: Env, surfaceId: string): Promise<RunSurfaceSnapshot> {
  const snapshot = await buildRunSurfaceSnapshot(env, surfaceId);
  const stub = env.RUN_SURFACES.get(env.RUN_SURFACES.idFromName(surfaceId));
  const response = await stub.fetch("https://run-surface.internal/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error("The realtime run surface could not be updated.");
  return snapshot;
}

export function defaultLocalEventCode(phase: string): RunStreamEventCode {
  return localCode(phase);
}
