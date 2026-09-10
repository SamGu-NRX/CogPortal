import { and, eq } from "drizzle-orm";
import { FIXTURE_PHASE_DURATIONS_MS } from "@cogworks/contracts/fixtures";
import { RUN_PHASES, isTerminal, type FailureCategory } from "@cogworks/contracts/schema";
import type { Database } from "../db/client";
import { officialAttempts, runMetrics, runPhases, runs, type RunRow } from "../db/schema";
import { fixtureLog, fixtureMetrics, fixtureScenario } from "./fixture";
import { refundOfficialAttempt, withRefundCapNotice } from "./refunds";

const CONSUMING_FAILURES = new Set<FailureCategory>([
  "student_runtime",
  "timeout",
  "memory_limit",
  "output_invalid",
]);

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

  for (const phase of phaseValues) {
    await db
      .insert(runPhases)
      .values(phase)
      .onConflictDoUpdate({
        target: [runPhases.runId, runPhases.phase],
        set: { startedAt: phase.startedAt, endedAt: phase.endedAt },
      });
  }

  const evaluatingOffset = RUN_PHASES.slice(0, RUN_PHASES.indexOf("evaluating")).reduce(
    (total, phase) => total + FIXTURE_PHASE_DURATIONS_MS[phase],
    0,
  );
  if (row.mode === "official" && now >= row.createdAt + evaluatingOffset) {
    await db
      .update(officialAttempts)
      .set({ consumed: true })
      .where(eq(officialAttempts.runId, row.id));
  }

  const studentFault = terminalFailure
    ? (terminalFailure.phase === "evaluating" || terminalFailure.phase === "scoring") &&
      CONSUMING_FAILURES.has(terminalFailure.category)
    : false;
  // A failure that is ours gives the attempt back, up to the per-team,
  // per-benchmark cap in ./refunds.ts. Past the cap the attempt stays spent,
  // so the run has to say both things: `consumedAttempt` reports what really
  // happened to the attempt (FailureCard.tsx renders it as the authoritative
  // line), and the detail explains why, because a team that silently lost an
  // attempt to our failure cannot tell that from a bug.
  let failureDetail = terminalFailure?.detail ?? null;
  let consumedAttempt = studentFault;
  if (terminalFailure && !studentFault) {
    const outcome = await refundOfficialAttempt(db, row, now);
    if (outcome === "capped") {
      failureDetail = withRefundCapNotice(failureDetail);
      consumedAttempt = true;
    }
  }

  if (nextStatus === "succeeded") {
    for (const metric of fixtureMetrics(row.id, row.branch, row.benchmarkId)) {
      await db
        .insert(runMetrics)
        .values({
          runId: row.id,
          key: metric.key,
          label: metric.label,
          value: metric.value,
          unit: metric.unit,
          higherIsBetter: metric.higherIsBetter,
          isPrimary: metric.primary,
          precision: metric.precision,
          // The fixture path dropped help as well, so a fixture run could not
          // reproduce what a real one renders.
          help: metric.help ?? null,
          role: metric.role ?? null,
          relatesTo: metric.relatesTo ?? null,
        })
        .onConflictDoUpdate({
          target: [runMetrics.runId, runMetrics.key],
          set: {
            label: metric.label,
            value: metric.value,
            unit: metric.unit,
            higherIsBetter: metric.higherIsBetter,
            isPrimary: metric.primary,
            precision: metric.precision,
            help: metric.help ?? null,
            role: metric.role ?? null,
            relatesTo: metric.relatesTo ?? null,
          },
        });
    }
  }

  await db
    .update(runs)
    .set({
      status: nextStatus,
      finishedAt,
      failureCategory: terminalFailure?.category ?? null,
      failurePhase: terminalFailure?.phase ?? null,
      failureDetail,
      failureConsumedAttempt: consumedAttempt,
      log:
        row.mode === "practice" && (nextStatus === "succeeded" || nextStatus === "failed")
          ? fixtureLog(row.id, row.branch, row.sha, row.benchmarkId)
          : null,
    })
    .where(eq(runs.id, row.id));

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
