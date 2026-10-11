import { and, eq, exists, notInArray, sql } from "drizzle-orm";
import { FIXTURE_PHASE_DURATIONS_MS } from "@cogworks/contracts/fixtures";
import { RUN_PHASES, isTerminal, type FailureCategory } from "@cogworks/contracts/schema";
import type { Database } from "../db/client";
import { officialAttempts, runMetrics, runPhases, runs, type RunRow } from "../db/schema";
import { fixtureLog, fixtureMetrics, fixtureScenario } from "./fixture";

/**
 * Advances a fixture run to the state implied by wall-clock time. This lazy,
 * poll-driven state machine is the Milestone-1 stand-in for the durable Workflow
 * orchestrator. Every write is an idempotent update/upsert, so repeated GET polls
 * safely converge on the same phase timings, metrics, log, and attempt state.
 */
export async function syncRun(db: Database, row: RunRow, now = Date.now()): Promise<RunRow> {
  if (isTerminal(row.status)) return row;
  if (row.provider !== "fixture") return row;

  const scenario = fixtureScenario(row.branch);
  let offset = 0;
  let nextStatus: RunRow["status"] = "queued";
  let finishedAt: number | null = null;
  let terminalFailure:
    | { category: FailureCategory; phase: (typeof RUN_PHASES)[number]; detail: string }
    | null = null;
  const phaseValues: Array<typeof runPhases.$inferInsert> = [];

  for (const phase of RUN_PHASES) {
    const startedAt = row.createdAt + offset;
    const endedAt = startedAt + FIXTURE_PHASE_DURATIONS_MS[phase];
    const hasStarted = now >= startedAt;
    const hasEnded = now >= endedAt;
    phaseValues.push({
      runId: row.id,
      phase,
      startedAt: hasStarted ? startedAt : null,
      endedAt: hasEnded ? endedAt : null,
    });

    if (hasStarted && !hasEnded) nextStatus = phase;
    if (scenario.outcome.kind === "failed" && scenario.outcome.phase === phase && hasEnded) {
      nextStatus = "failed";
      finishedAt = endedAt;
      terminalFailure = scenario.outcome;
      break;
    }
    offset += FIXTURE_PHASE_DURATIONS_MS[phase];
  }

  const totalDuration = RUN_PHASES.reduce(
    (total, phase) => total + FIXTURE_PHASE_DURATIONS_MS[phase],
    0,
  );
  if (scenario.outcome.kind === "succeeded" && now >= row.createdAt + totalDuration) {
    nextStatus = "succeeded";
    finishedAt = row.createdAt + totalDuration;
  }

  const eligible = and(
    eq(runs.id, row.id),
    notInArray(runs.status, ["succeeded", "failed", "cancelled"]),
    // An older poll must not move a newer poll's phase backward.
    sql`case ${runs.status}
      when 'queued' then 0 when 'preparing' then 1 when 'installing' then 2
      when 'contract_check' then 3 when 'evaluating' then 4 when 'scoring' then 5
      else 6 end <= ${nextStatus === "failed" || nextStatus === "succeeded" ? 6 : RUN_PHASES.indexOf(nextStatus)}`,
  );
  const eligibleExists = exists(db.select({ id: runs.id }).from(runs).where(eligible));
  const [firstPhase, ...remainingPhases] = phaseValues.map((phase) => db.insert(runPhases).select(db.select({
      runId: sql<string>`${phase.runId}`.as("runId"),
      phase: sql<typeof phase.phase>`${phase.phase}`.as("phase"),
      startedAt: sql<number | null>`${phase.startedAt}`.as("startedAt"),
      endedAt: sql<number | null>`${phase.endedAt}`.as("endedAt"),
    }).from(runs).where(eligible)).onConflictDoUpdate({
      target: [runPhases.runId, runPhases.phase],
      set: { startedAt: phase.startedAt, endedAt: phase.endedAt },
    }));
  if (!firstPhase) throw new Error("Fixture run has no phases.");
  await db.batch([
    firstPhase, ...remainingPhases,
    ...(nextStatus === "succeeded" ? fixtureMetrics(row.id, row.branch, row.benchmarkId).map((metric) =>
      db.insert(runMetrics).select(db.select({
        runId: sql<string>`${row.id}`.as("runId"),
        key: sql<string>`${metric.key}`.as("key"),
        label: sql<string>`${metric.label}`.as("label"),
        value: sql<number>`${metric.value}`.as("value"),
        unit: sql<string | null>`${metric.unit}`.as("unit"),
        higherIsBetter: sql<boolean>`${Number(metric.higherIsBetter)}`.as("higherIsBetter"),
        isPrimary: sql<boolean>`${Number(metric.primary)}`.as("isPrimary"),
        precision: sql<number>`${metric.precision}`.as("precision"),
        help: sql<string | null>`${metric.help ?? null}`.as("help"),
        role: sql<typeof runMetrics.$inferInsert.role>`${metric.role ?? null}`.as("role"),
        relatesTo: sql<string | null>`${metric.relatesTo ?? null}`.as("relatesTo"),
      }).from(runs).where(eligible)).onConflictDoNothing()
    ) : []),
    ...(nextStatus === "failed" ? [
      db.delete(officialAttempts).where(and(eq(officialAttempts.runId, row.id), eligibleExists)),
    ] : []),
    db.update(runs).set({
      status: nextStatus,
      finishedAt,
      failureCategory: terminalFailure?.category ?? null,
      failurePhase: terminalFailure?.phase ?? null,
      failureDetail: terminalFailure?.detail ?? null,
      failureConsumedAttempt: false,
      log: row.mode === "practice" && (nextStatus === "succeeded" || nextStatus === "failed")
        ? fixtureLog(row.id, row.branch, row.sha, row.benchmarkId)
        : null,
    }).where(eligible),
  ]);

  const [updated] = await db.select().from(runs).where(eq(runs.id, row.id)).limit(1);
  return updated ?? row;
}

export async function syncTeamRuns(
  db: Database,
  teamId: string,
  benchmarkId?: string,
  now = Date.now(),
): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(
      benchmarkId
        ? and(eq(runs.teamId, teamId), eq(runs.benchmarkId, benchmarkId))
        : eq(runs.teamId, teamId),
    );
  return Promise.all(rows.map((run) => syncRun(db, run, now)));
}
