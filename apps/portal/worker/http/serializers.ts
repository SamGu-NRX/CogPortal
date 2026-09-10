import { and, asc, eq } from "drizzle-orm";
import {
  RUN_PHASES,
  RunDetailSchema,
  runSource,
  type Benchmark,
  type Metric,
  type RunDetail,
  type RunSummary,
  type Team,
} from "@cogworks/contracts/schema";
import { runSourceRefusal } from "../services/run-actions";
import type { Database } from "../db/client";
import {
  leaderboardSelections,
  runMetrics,
  runPhases,
  type BenchmarkRow,
  type RunRow,
  type TeamRow,
} from "../db/schema";

export function serializeBenchmark(row: BenchmarkRow): Benchmark {
  return {
    id: row.id,
    version: row.version,
    contractVersion: row.contractVersion,
    entryPointName: row.entryPointName,
    title: row.title,
    module: row.module,
    summary: row.summary,
    active: row.active,
    pluginVersion: row.pluginVersion,
    datasetVersion: row.datasetVersion,
    scorerVersion: row.scorerVersion,
    runtimeVersion: row.runtimeVersion,
  };
}

export function serializeTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provenance: row.provenance,
    repo: {
      owner: row.repoOwner,
      name: row.repoName,
      fullName: row.repoFullName,
      url: row.repoUrl,
      defaultBranch: row.defaultBranch,
    },
  };
}

export function serializeMetric(row: typeof runMetrics.$inferSelect): Metric {
  return {
    key: row.key,
    label: row.label,
    value: row.value,
    unit: row.unit,
    higherIsBetter: row.higherIsBetter,
    primary: row.isPrimary,
    precision: row.precision,
    help: row.help,
    role: row.role,
    relatesTo: row.relatesTo,
  };
}

export async function serializeRunSummary(db: Database, row: RunRow): Promise<RunSummary> {
  const [primary] = await db
    .select()
    .from(runMetrics)
    .where(and(eq(runMetrics.runId, row.id), eq(runMetrics.isPrimary, true)))
    .limit(1);

  return {
    id: row.id,
    // The run's own source, so a commit in a list can be attributed. Detail
    // spreads this summary, so both answer from the same place.
    repo: runSource(row.repositoryFullName),
    mode: row.mode,
    status: row.status,
    benchmarkId: row.benchmarkId,
    benchmarkVersion: row.benchmarkVersion,
    branch: row.branch,
    sha: row.sha,
    shortSha: row.sha.slice(0, 7),
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    attemptNumber: row.attemptNumber,
    primaryMetric: primary ? serializeMetric(primary) : null,
    failure:
      row.failureCategory && row.failurePhase
        ? {
            category: row.failureCategory,
            phase: row.failurePhase,
            detail: row.failureDetail,
            consumedAttempt: row.failureConsumedAttempt,
          }
        : null,
  };
}

/**
 * A run, in full, from the run's own row.
 *
 * The team is here for one question only: whether a new promotion of this run
 * could still be authorised, which is genuinely about the team as it is now.
 * What the run *was* still comes from the run. Those two were the same
 * expression once, and that is what made every old run claim the team's
 * current repository.
 */
export async function serializeRunDetail(
  db: Database,
  row: RunRow,
  team: { repoId: number | null; repoFullName: string },
): Promise<RunDetail> {
  const [summary, phases, metrics, selection] = await Promise.all([
    serializeRunSummary(db, row),
    db.select().from(runPhases).where(eq(runPhases.runId, row.id)).orderBy(asc(runPhases.phase)),
    db.select().from(runMetrics).where(eq(runMetrics.runId, row.id)).orderBy(asc(runMetrics.key)),
    db
      .select({ runId: leaderboardSelections.runId })
      .from(leaderboardSelections)
      .where(
        and(
          eq(leaderboardSelections.teamId, row.teamId),
          eq(leaderboardSelections.benchmarkId, row.benchmarkId),
          eq(leaderboardSelections.benchmarkVersion, row.benchmarkVersion),
        ),
      )
      .limit(1),
  ]);
  const phaseOrder = new Map(RUN_PHASES.map((phase, index) => [phase, index]));

  return {
    ...summary,
    contractVersion: row.contractVersion,
    parentRunId: row.parentRunId,
    sourceRefusal: runSourceRefusal(team, row, "promote it"),
    phases: phases
      .sort((a, b) => (phaseOrder.get(a.phase) ?? 0) - (phaseOrder.get(b.phase) ?? 0))
      .map((phase) => ({
        phase: phase.phase,
        startedAt: phase.startedAt,
        endedAt: phase.endedAt,
      })),
    metrics: metrics.map(serializeMetric),
    // Unlike the log, diagnostics are safe on official runs: they describe the
    // submission's own output shape, never the hidden data.
    diagnostics: parseDiagnostics(row.diagnosticsJson),
    sweep: parseSweep(row.sweepJson),
    // Named for their own functions, so it is safe on an official run for the
    // same reason diagnostics are: it describes their code, never the data.
    wiring: parseWiring(row.wiringJson),
    // Names their own modules and functions, so it is safe on an official run
    // for the same reason diagnostics are.
    refusal: parseRefusal(row.refusalJson),
    weightsSupplied: parseWeightsSupplied(row.weightsSuppliedJson),
    log: row.mode === "practice" ? row.log : null,
    selected: selection[0]?.runId === row.id,
  };
}

/** Stored as JSON by the runner-event handler. A malformed or absent value is
 *  not worth failing a run detail over; show none rather than break the page. */
function parseDiagnostics(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, 32);
  } catch {
    return [];
  }
}

/** Same tolerance again: a malformed refusal costs the explanation, never the
 *  page. The capped `failure.detail` still renders either way. */
function parseRefusal(value: string | null): RunDetail["refusal"] {
  if (!value) return null;
  try {
    const parsed = RunDetailSchema.shape.refusal.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Same tolerance again: a malformed wiring record costs that panel, never
 *  the page. */
function parseWiring(value: string | null): RunDetail["wiring"] {
  if (!value) return [];
  try {
    const parsed = RunDetailSchema.shape.wiring.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Same tolerance as `parseDiagnostics`: a malformed sweep costs the curve,
 *  never the page. Validated against the schema rather than trusted, because
 *  this is stored JSON and a shape change would otherwise reach the browser
 *  as a render crash. */
function parseSweep(value: string | null): RunDetail["sweep"] {
  if (!value) return null;
  try {
    const parsed = RunDetailSchema.shape.sweep.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseWeightsSupplied(value: string): RunDetail["weightsSupplied"] {
  try {
    const parsed = RunDetailSchema.shape.weightsSupplied.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
