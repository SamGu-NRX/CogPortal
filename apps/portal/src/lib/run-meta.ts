/**
 * Display vocabulary for run state — the phase rail wording comes verbatim
 * from handoff-plan §8: Queued → Prepare → Install → Contract check →
 * Evaluate → Score → Complete.
 */
import type { RunPhase, RunStatus } from "@cogworks/contracts/schema";
import { RUN_PHASES, isTerminal } from "@cogworks/contracts/schema";

export const PHASE_LABELS: Record<RunPhase, string> = {
  queued: "Queued",
  preparing: "Prepare",
  installing: "Install",
  contract_check: "Contract check",
  evaluating: "Evaluate",
  scoring: "Score",
};

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  installing: "Installing",
  contract_check: "Contract check",
  evaluating: "Evaluating",
  scoring: "Scoring",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type StatusTone = "live" | "good" | "bad" | "muted";

export function statusTone(status: RunStatus): StatusTone {
  if (status === "succeeded") return "good";
  if (status === "failed") return "bad";
  if (status === "cancelled") return "muted";
  return "live";
}

export function phaseIndex(phase: RunPhase): number {
  return RUN_PHASES.indexOf(phase);
}

/** Index of the phase a run is currently in, or has reached terminally.
 *  Succeeded, cancelled, and failed runs without a known phase sit past the
 *  last phase on the rail. */
export function currentPhaseIndex(status: RunStatus, failedPhase?: RunPhase | null): number {
  switch (status) {
    case "failed":
      return failedPhase ? phaseIndex(failedPhase) : RUN_PHASES.length;
    case "succeeded":
    case "cancelled":
      return RUN_PHASES.length;
    default:
      // No cast needed: RUN_STATUSES is RUN_PHASES plus succeeded, failed,
      // and cancelled, so once the three terminal statuses are matched the
      // compiler narrows every remaining status to RunPhase.
      return phaseIndex(status);
  }
}

export { isTerminal };
