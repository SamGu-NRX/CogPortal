import type { RunRow } from "../db/schema";

export function canPublishOfficialRun(
  run: Pick<RunRow, "mode" | "status" | "refundedAt">,
): boolean {
  // Late findings remain readable, but a returned attempt cannot publish them.
  return run.mode === "official" && run.status === "succeeded" && run.refundedAt === null;
}
