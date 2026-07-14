import type { FailureCategory, Metric, RunPhase } from "@shared/schema";

export interface ResolveAndPrepareInput {
  runId: string;
  repoFullName: string;
  branch: string;
  sha: string;
  contractVersion: string;
  entryPointName: string;
}

export interface PreparedSubmission {
  cacheKey: string;
  sha: string;
  workspaceRef: string;
}

export interface ExecutionResult {
  outcome:
    | { kind: "succeeded" }
    | { kind: "failed"; category: FailureCategory; phase: RunPhase; detail: string };
  predictionsRef: string | null;
  log: string;
}

export interface ScoreResult {
  metrics: Metric[];
}

/**
 * Boundary between durable orchestration and untrusted student execution.
 * `resolveAndPrepare` resolves an exact SHA, installs under canonical constraints,
 * discovers the entry point, and produces a cacheable workspace. `execute` always
 * starts from a restored workspace in a fresh network-disabled VM. `score` runs
 * outside that VM so official labels and scorer code never cross the trust boundary.
 */
export interface ExecutionAdapter {
  resolveAndPrepare(input: ResolveAndPrepareInput): Promise<PreparedSubmission>;
  backup(prepared: PreparedSubmission): Promise<string>;
  execute(preparedBackup: string, input: ResolveAndPrepareInput): Promise<ExecutionResult>;
  score(execution: ExecutionResult, input: ResolveAndPrepareInput): Promise<ScoreResult>;
  persist(runId: string, execution: ExecutionResult, score: ScoreResult | null): Promise<void>;
}
