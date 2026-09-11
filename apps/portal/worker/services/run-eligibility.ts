import type { RunRow } from "../db/schema";

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
