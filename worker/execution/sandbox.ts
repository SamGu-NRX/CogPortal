import type {
  ExecutionAdapter,
  ExecutionResult,
  PreparedSubmission,
  ResolveAndPrepareInput,
  ScoreResult,
} from "./adapter";

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("Cloudflare Sandbox execution is not configured.");
    this.name = "ProviderNotConfiguredError";
  }
}

/** Real provider gate; intentionally unusable until handoff-plan §9 Milestone 0 passes. */
export class CloudflareSandboxAdapter implements ExecutionAdapter {
  private unavailable(): never {
    // TODO(M0, handoff-plan §9): pin matching @cloudflare/sandbox and container digest.
    // TODO(M0, handoff-plan §9): create the evaluation VM network-disabled from birth.
    // TODO(M0, handoff-plan §9): wrap commands with timeout --kill-after.
    // TODO(M0, handoff-plan §9): call sandbox.destroy() from every finally block.
    throw new ProviderNotConfiguredError();
  }

  resolveAndPrepare(_input: ResolveAndPrepareInput): Promise<PreparedSubmission> {
    return Promise.reject(this.unavailable());
  }

  backup(_prepared: PreparedSubmission): Promise<string> {
    return Promise.reject(this.unavailable());
  }

  execute(_backup: string, _input: ResolveAndPrepareInput): Promise<ExecutionResult> {
    return Promise.reject(this.unavailable());
  }

  score(_execution: ExecutionResult, _input: ResolveAndPrepareInput): Promise<ScoreResult> {
    return Promise.reject(this.unavailable());
  }

  persist(_runId: string, _execution: ExecutionResult, _score: ScoreResult | null): Promise<void> {
    return Promise.reject(this.unavailable());
  }
}
