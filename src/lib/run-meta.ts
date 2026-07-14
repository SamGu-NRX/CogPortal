/**
 * Display vocabulary for run state — the phase rail wording comes verbatim
 * from handoff-plan §8: Queued → Prepare → Install → Contract check →
 * Evaluate → Score → Complete.
 */
import type { RunPhase, RunStatus } from "@shared/schema";
import { RUN_PHASES, isTerminal } from "@shared/schema";

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

/** Index of the phase a run is currently in, or has reached terminally. */
export function currentPhaseIndex(status: RunStatus, failedPhase?: RunPhase | null): number {
  if (!isTerminal(status)) return phaseIndex(status as RunPhase);
  if (status === "failed" && failedPhase) return phaseIndex(failedPhase);
  return RUN_PHASES.length; // succeeded / cancelled → past the last phase
}

export { isTerminal };
