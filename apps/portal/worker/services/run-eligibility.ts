import { PreparedEnvironmentV1Schema, type PreparedEnvironmentV1 } from "@cogworks/contracts/protocol";
import type { BenchmarkRow, RunRow, TeamRow } from "../db/schema";

type SavedRun = Pick<RunRow,
  "preparedArtifactId" | "preparedEnvironmentJson" | "benchmarkId" | "repositoryId" | "sha"
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
  if (!preparedEnvironmentMatchesRun(parsed.data, run, team.repoFullName) || benchmark.id !== run.benchmarkId) {
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

/** Retry links, not timestamps, identify the execution currently on the console. */
export function currentSurfaceRun(rows: RunRow[], mode: RunRow["mode"]): RunRow | null {
  const replaced = new Set(rows.map((row) => row.retryOfRunId).filter((id) => id !== null));
  return rows.find((row) => row.mode === mode && !replaced.has(row.id)) ?? null;
}

export function canPublishOfficialRun(
  run: Pick<RunRow, "mode" | "status" | "refundedAt">,
): boolean {
  // Late findings remain readable, but a returned attempt cannot publish them.
  return run.mode === "official" && run.status === "succeeded" && run.refundedAt === null;
}
