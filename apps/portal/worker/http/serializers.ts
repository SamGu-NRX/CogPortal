import { and, asc, eq, inArray } from "drizzle-orm";
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
import { runSourceRefusal } from "../services/run-source";
import type { Database } from "../db/client";
import { canPublishOfficialRun, savedEnvironmentEligibility } from "../services/run-eligibility";
import {
  benchmarks,
  leaderboardSelections,
  runMetrics,
  runPhases,
  type BenchmarkRow,
  type RunMetricRow,
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

export function serializeMetric(row: RunMetricRow): Metric {
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

/** D1 binds at most 100 parameters per statement; one of them here is the
 *  primary flag, so an id list is read in pages of 99. */
const IDS_PER_STATEMENT = 99;

/**
 * The primary metric of each run named, in as few statements as D1 allows.
 *
 * A page that lists runs reads this once for the whole page instead of once
 * per run, and hands over whatever list it has: the run list has no page
 * bound, so the paging lives here rather than at each caller.
 */
export async function readPrimaryMetrics(
  db: Database,
  runIds: string[],
): Promise<Map<string, RunMetricRow>> {
  const primaries = new Map<string, RunMetricRow>();
  for (let start = 0; start < runIds.length; start += IDS_PER_STATEMENT) {
    const rows = await db
      .select()
      .from(runMetrics)
      .where(and(
        inArray(runMetrics.runId, runIds.slice(start, start + IDS_PER_STATEMENT)),
        eq(runMetrics.isPrimary, true),
      ));
    for (const row of rows) primaries.set(row.runId, row);
  }
  return primaries;
}

export function buildRunSummary(row: RunRow, primary: RunMetricRow | null): RunSummary {
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
            // Kept on the wire for older clients; failures no longer use quota.
            consumedAttempt: false,
          }
        : null,
  };
}

export async function serializeRunSummary(db: Database, row: RunRow): Promise<RunSummary> {
  const primaries = await readPrimaryMetrics(db, [row.id]);
  return buildRunSummary(row, primaries.get(row.id) ?? null);
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
  // Independent reads, so they travel as one D1 round trip rather than three.
  // The summary's primary metric comes out of the metrics this already reads,
  // the way the leaderboard picks its primary, so it costs no fourth statement.
  const [phases, metrics, selection] = await db.batch([
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
  const summary = buildRunSummary(row, metrics.find((metric) => metric.isPrimary) ?? null);
  const phaseOrder = new Map(RUN_PHASES.map((phase, index) => [phase, index]));
  let promotionRefusal: string | null = null;
  if (row.provider === "modal" && row.mode === "practice" && row.status === "succeeded" && row.refundedAt === null) {
    const [benchmark] = await db.select().from(benchmarks)
      .where(and(eq(benchmarks.id, row.benchmarkId), eq(benchmarks.version, row.benchmarkVersion))).limit(1);
    const eligibility = savedEnvironmentEligibility(row,
      benchmark ?? { id: row.benchmarkId, sandboxContract: null }, team);
    if (!eligibility.eligible) promotionRefusal = eligibility.reason;
  }

  return {
    ...summary,
    promotionRefusal,
    surfaceId: row.surfaceId,
    contractVersion: row.contractVersion,
    parentRunId: row.parentRunId,
    // One sentence under both PROMOTE and PUBLISH, so it names no single
    // action. Same phrase the console uses for the same shared refusal.
    sourceRefusal: runSourceRefusal(team, row, "act on it"),
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
    publishable: canPublishOfficialRun(row),
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
