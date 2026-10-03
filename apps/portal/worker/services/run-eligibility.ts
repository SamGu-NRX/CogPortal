import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { PreparedEnvironmentV1Schema, type PreparedEnvironmentV1 } from "@cogworks/contracts/protocol";
import type { PromotedTo } from "@cogworks/contracts/schema";
import type { BenchmarkRow, RunRow, TeamRow } from "../db/schema";

type SavedRun = Pick<RunRow,
  "preparedArtifactId" | "preparedEnvironmentJson" | "benchmarkId" | "repositoryId"
  | "repositoryFullName" | "sha"
>;
type EnvironmentEligibility =
  | { eligible: true; environment: PreparedEnvironmentV1 }
  | { eligible: false; reason: string };

/** Validate binding separately from compatibility so a late completion can retain
 * historical evidence even after the catalog's sandbox contract changes. */
export function preparedEnvironmentMatchesRun(
  environment: PreparedEnvironmentV1,
  run: Pick<SavedRun, "preparedArtifactId" | "benchmarkId" | "repositoryId" | "sha">,
  repositoryFullName: string,
): boolean {
  return environment.artifactId === run.preparedArtifactId &&
    environment.benchmarkId === run.benchmarkId &&
    environment.source.repositoryId === run.repositoryId &&
    environment.source.fullName === repositoryFullName &&
    environment.source.sha === run.sha;
}

export function savedEnvironmentEligibility(
  run: SavedRun,
  benchmark: Pick<BenchmarkRow, "id" | "sandboxContract">,
  team: Pick<TeamRow, "repoFullName" | "repoId">,
): EnvironmentEligibility {
  // A repository can be replaced under the same owner/name. Reuse requires
  // the connected repository's immutable ID, not just its current name.
  if (team.repoId === null || team.repoId !== run.repositoryId) {
    return { eligible: false, reason: "The saved environment can't be matched to the connected repository." };
  }
  let value: unknown;
  try {
    value = run.preparedEnvironmentJson ? JSON.parse(run.preparedEnvironmentJson) : null;
  } catch {
    return { eligible: false, reason: "The saved environment's provisioning record is invalid." };
  }
  const parsed = PreparedEnvironmentV1Schema.safeParse(value);
  if (!parsed.success) {
    return { eligible: false, reason: "The saved environment's compatibility is unknown." };
  }
  // The name the run recorded, not the team's current one. A rename keeps
  // repoId, and the dispatch job carries the recorded name, so `recordedJob`
  // compares the environment against that. Comparing against the team here
  // left the two checks unsatisfiable at once for any renamed repository.
  const repositoryFullName = run.repositoryFullName ?? team.repoFullName;
  if (!preparedEnvironmentMatchesRun(parsed.data, run, repositoryFullName) || benchmark.id !== run.benchmarkId) {
    return { eligible: false, reason: "The saved environment doesn't match this run's source and artifact." };
  }
  // Scorer, image and runtime labels describe different facts. Only the
  // catalog's explicit sandbox contract decides whether this artifact can run.
  if (benchmark.sandboxContract === null || !Number.isSafeInteger(benchmark.sandboxContract) ||
      benchmark.sandboxContract <= 0 || parsed.data.sandboxContract !== benchmark.sandboxContract) {
    return { eligible: false, reason: "The saved environment isn't compatible with this benchmark's current execution contract." };
  }
  // Match EVALUATE_SCRIPT's major/minor requirement, not the image build's
  // patch pin. A different 3.8 patch is not evidence of incompatibility.
  if ((benchmark.id === "audio-identification" || benchmark.id === "language-search") &&
      !/^3\.8\.[0-9]+$/.test(parsed.data.pythonVersion)) {
    return { eligible: false, reason: "The saved environment doesn't meet this benchmark's Python 3.8 requirement." };
  }
  return { eligible: true, environment: parsed.data };
}

/**
 * A fixture run records no dispatch job, so the labels on its own row are the
 * only evidence of what it ran; Modal's equivalent is `recordedJob`. Admission
 * and the console read this one function, so the console cannot offer a Retry
 * admission would refuse.
 */
export function fixtureRetryRefusal(
  run: Pick<RunRow, "provider" | "mode" | "contractVersion" | "scorerVersion" | "runtimeVersion" | "datasetVersion">,
  benchmark: Pick<BenchmarkRow, "contractVersion" | "scorerVersion" | "runtimeVersion" | "datasetVersion">,
): string | null {
  if (run.provider !== "fixture") return null;
  const changed = run.contractVersion !== benchmark.contractVersion
    || run.scorerVersion !== benchmark.scorerVersion
    || run.runtimeVersion !== benchmark.runtimeVersion
    || run.datasetVersion !== (run.mode === "official" ? benchmark.datasetVersion : "practice-v1");
  return changed ? "The recorded benchmark configuration has changed. Start a new candidate." : null;
}

/**
 * Whether a failure's own category allows running the same commit again.
 *
 * The catalog's "fix" remedy is its policy for causes the runner saw in what
 * the submission did (an install, a timeout, the memory limit, the output
 * shape): the next step is a change to the code, not the same commit again.
 * That is a policy, not a proof that a rerun would fail identically. Failed
 * executions use no quota, so without it such a commit could be resent
 * indefinitely on hosted compute. An uncategorized failure stays retryable: nothing says it was the
 * submission. Admission and the console both read this, so the console never
 * offers a Retry that admission refuses.
 */
export function failureAllowsRetry(run: Pick<RunRow, "failureCategory">): boolean {
  return run.failureCategory === null || FAILURE_CATALOG[run.failureCategory].remedy !== "fix";
}

/** Retry links, not timestamps, identify the execution currently on the console. */
export function currentSurfaceRun(rows: RunRow[], mode: RunRow["mode"]): RunRow | null {
  const replaced = new Set(rows.map((row) => row.retryOfRunId).filter((id) => id !== null));
  return rows.find((row) => row.mode === mode && !replaced.has(row.id)) ?? null;
}

/**
 * The official attempt a practice run was already promoted to, read from the
 * rows on its console. Promotion answers with this attempt instead of spending
 * another, so it is also what the dashboard and run page offer in place of
 * Promote. `refusal` is set when that attempt can't stand in for the promotion
 * any more, and says what to do next.
 */
/** A practice run recorded before runs had a console has nowhere to attach an
 *  official attempt, so promotion refuses it. The pages say so instead of
 *  offering the control. */
export const NO_CONSOLE_PROMOTION_REFUSAL =
  "This run is from before runs had a console, so it can't be promoted. Start a new practice run to create a candidate.";

export interface ExistingPromotion {
  promotedTo: PromotedTo;
  refusal: string | null;
}

export function existingPromotion(surfaceRows: RunRow[]): ExistingPromotion | null {
  const official = currentSurfaceRun(surfaceRows, "official");
  if (!official) return null;
  const next = "Start a new practice run to create the next candidate to promote.";
  const refusal = official.status === "failed"
    ? `That official attempt already ran and failed. ${next}`
    : official.refundedAt !== null
      ? `That official attempt was refunded. ${next}`
      : null;
  return { promotedTo: { runId: official.id, attemptNumber: official.attemptNumber }, refusal };
}

export function canPublishOfficialRun(
  run: Pick<RunRow, "mode" | "status" | "refundedAt">,
): boolean {
  // Late findings remain readable, but a returned attempt cannot publish them.
  return run.mode === "official" && run.status === "succeeded" && run.refundedAt === null;
}

/** The part of `rankingRefusal` that reads only the run's own row, for a
 *  caller that has to answer it before reading the catalog. */
export function runStateRefusal(run: Pick<RunRow, "mode" | "status" | "refundedAt">): string | null {
  if (canPublishOfficialRun(run)) return null;
  return run.refundedAt !== null
    ? "This attempt was refunded, so its findings can't be published. Choose another official run."
    : "Only a succeeded official run can be published.";
}

/**
 * Why this official run can't stand on the benchmark's current leaderboard,
 * or null when it can.
 *
 * A board ranks one measure: the catalog's `primaryMetricKey`, produced by the
 * catalog's current scorer. A run's own `isPrimary` flag is a different fact.
 * A partial Language result flags the text MRR it could compute because it has
 * no `overall` (plugins.py in the language benchmark), and ranking that
 * against another team's `overall` compares two different numbers.
 *
 * Publication, both boards and every "published" label answer from this, so
 * none of them can call a selection published that the board leaves out. A
 * refused selection stays stored; it just isn't claimed.
 */
export function rankingRefusal(
  run: Pick<RunRow, "mode" | "status" | "refundedAt" | "scorerVersion">,
  benchmark: Pick<BenchmarkRow, "scorerVersion" | "primaryMetricKey"> | null | undefined,
  metrics: readonly { key: string }[],
): string | null {
  const state = runStateRefusal(run);
  if (state) return state;
  if (!benchmark || run.scorerVersion !== benchmark.scorerVersion) {
    return "This run used different scoring rules and can't appear in the current ranking.";
  }
  if (!metrics.some((metric) => metric.key === benchmark.primaryMetricKey)) {
    return `The leaderboard ranks teams by "${benchmark.primaryMetricKey}", and this run didn't report it, so it can't be published. What it did report stays readable here.`;
  }
  return null;
}
