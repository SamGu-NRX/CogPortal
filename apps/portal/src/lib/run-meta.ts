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

/**
 * What "queued" means, said once for both surfaces that show one.
 *
 * "Queued" beside a climbing clock is the one status a student cannot act on
 * and cannot tell apart from a hang. Two things are deliberate here. All the
 * portal observes is that no phase callback has arrived: dispatch can be lost
 * after the job started (execution/runner.ts), so "waiting for a machine" was
 * a cause we cannot see. And the sweep marks the database row failed; it does
 * not reach into Modal and stop anything, so "we stop it" was not what
 * happens. Ten minutes is the sweep's threshold and the cron runs every five
 * (execution/maintenance.ts, wrangler.jsonc), so a run that crosses ten is
 * ended somewhere in the next five; the range is the honest number.
 */
export const QUEUED_WAIT_NOTE =
  "Nothing has reported back yet, which is usually a short wait for a free " +
  "machine. If nothing arrives within ten to fifteen minutes we stop waiting " +
  "and mark this run failed, so it won't sit here all afternoon.";

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
