import type { ExecutionAdapter, ResolveAndPrepareInput, ScoreResult } from "../execution/adapter";

/**
 * Durable orchestration shape from handoff-plan §5. This plain class deliberately
 * avoids a `cloudflare:workers` Workflow base class until the commented binding in
 * wrangler.jsonc is enabled after Milestone 0.
 */
export class RunWorkflow {
  constructor(private readonly adapter: ExecutionAdapter) {}

  async run(input: ResolveAndPrepareInput): Promise<void> {
    // Durable step: resolve exact ref, then prepare using the runtime/contract cache key.
    const prepared = await this.adapter.resolveAndPrepare(input);
    // Durable step: back up only the prepared filesystem; the preparation VM is gone.
    const backup = await this.adapter.backup(prepared);
    // Durable step: restore into a fresh, network-disabled evaluation VM.
    const execution = await this.adapter.execute(backup, input);
    // Durable step: score outside the student VM only after valid predictions return.
    let score: ScoreResult | null = null;
    if (execution.outcome.kind === "succeeded") score = await this.adapter.score(execution, input);
    // Durable step: atomically persist terminal state, metrics, diagnostics, and quota effects.
    await this.adapter.persist(input.runId, execution, score);
  }
}
