import type {
  RunStreamEvent,
  RunStreamEventCode,
  RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import type { EmojiFormatter } from "./emoji.ts";
import { chip, elapsed } from "./format.ts";

/**
 * The multi-step loader: the running message's body, a monotonic vertical
 * checklist in the Aceternity grammar. Completed steps carry the verify check
 * and a mono time chip citing the observed event; the active step carries the
 * spinner at full weight; future steps sit dimmed in subtext with a font
 * glyph (custom emoji do not scale down inside `-#` lines).
 */

export type StepKey = "prepare" | "check" | "evaluate" | "score";
export type StepState = "done" | "active" | "failed" | "pending";

export interface LoaderStep {
  key: StepKey;
  state: StepState;
  label: string;
  /** Mono chip content: an observed completion time or a live count. */
  chip?: string;
}

const STEP_ORDER: StepKey[] = ["prepare", "check", "evaluate", "score"];

/** Labels change with state: done lines cite evidence, active lines narrate. */
const LABELS: Record<StepKey, { pending: string; active: string; done: string }> = {
  prepare: { pending: "Preparation", active: "Preparing the bench", done: "Bench prepared" },
  check: { pending: "Contract check", active: "Checking the contract", done: "Contract passed" },
  evaluate: { pending: "Evaluation", active: "Evaluating", done: "Evaluated" },
  score: { pending: "Scoring", active: "Reading the gauges", done: "Scored" },
};

const KNOWN_PHASES = new Set([
  "queued",
  "preparing",
  "installing",
  "contract_check",
  "evaluating",
  "scoring",
]);

/**
 * At terminal the snapshot's `phase` column often holds the status word, not
 * the phase the run stopped in; the event history knows. Returns null when
 * nothing observed names a phase, so copy never claims one.
 */
export function effectivePhase(
  snapshot: RunSurfaceSnapshot,
  currentEvents: readonly RunStreamEvent[],
): string | null {
  if (KNOWN_PHASES.has(snapshot.phase)) return snapshot.phase;
  for (let index = currentEvents.length - 1; index >= 0; index -= 1) {
    if (KNOWN_PHASES.has(currentEvents[index]!.phase)) return currentEvents[index]!.phase;
  }
  return null;
}

function stepIndexForPhase(phase: string): number {
  if (phase === "queued" || phase === "preparing" || phase === "installing") return 0;
  if (phase === "contract_check") return 1;
  if (phase === "evaluating") return 2;
  return 3;
}

/** The event that proves a step finished; its elapsedMs becomes the time chip. */
const COMPLETION_EVENTS: Record<StepKey, RunStreamEventCode[]> = {
  prepare: ["contract.checking", "contract.passed"],
  check: ["contract.passed", "evaluation.started", "evaluation.progress"],
  evaluate: ["scoring.started"],
  score: ["run.completed"],
};

function completionChip(step: StepKey, events: readonly RunStreamEvent[]): string | undefined {
  for (const code of COMPLETION_EVENTS[step]) {
    const found = events.find((event) => event.code === code);
    if (found?.elapsedMs != null) return chip(elapsed(found.elapsedMs));
  }
  return undefined;
}

export function loaderSteps(
  snapshot: RunSurfaceSnapshot,
  currentEvents: readonly RunStreamEvent[],
): LoaderStep[] {
  const activeIndex = stepIndexForPhase(effectivePhase(snapshot, currentEvents) ?? "queued");
  return STEP_ORDER.map((key, index) => {
    const state: StepState =
      snapshot.status === "succeeded" || index < activeIndex
        ? "done"
        : index > activeIndex
          ? "pending"
          : snapshot.status === "failed"
            ? "failed"
            : snapshot.status === "cancelled"
              ? "pending"
              : "active";
    const variant = state === "done" ? "done" : state === "pending" ? "pending" : "active";
    const step: LoaderStep = { key, state, label: LABELS[key][variant] };
    if (state === "done") {
      step.chip = completionChip(key, currentEvents);
      if (key === "evaluate" && snapshot.progress) {
        step.chip = chip(`${snapshot.progress.total}/${snapshot.progress.total}`);
      }
    }
    if (state === "active" && key === "evaluate" && snapshot.progress) {
      step.chip = chip(`${snapshot.progress.current}/${snapshot.progress.total}`);
    }
    return step;
  });
}

/**
 * One rendered loader line per step. Done and active steps carry their glyph;
 * a pending step is plain dimmed subtext with no marker, so the eye lands on
 * what is happening now and there is no font-glyph circle to look rough.
 */
export function loaderLine(step: LoaderStep, fmt: EmojiFormatter): string {
  const suffix = step.chip ? `  ${step.chip}` : "";
  if (step.state === "pending") return `-# ${step.label}`;
  if (step.state === "active") return `${fmt("cog_spin")} **${step.label}**${suffix}`;
  if (step.state === "failed") return `${fmt("cog_fail")} ${step.label}${suffix}`;
  return `${fmt("cog_done")} ${step.label}${suffix}`;
}

/**
 * The failed-state trace: the last observed good line plus the failure line,
 * so the team sees where it stopped without a full log. The failure line
 * prefers the safe category copy of the run.failed.* event when present.
 */
export function failureTrace(
  snapshot: RunSurfaceSnapshot,
  currentEvents: readonly RunStreamEvent[],
  failureCopy: (code: RunStreamEventCode) => string | undefined,
  fmt: EmojiFormatter,
): string[] {
  const steps = loaderSteps(snapshot, currentEvents);
  const lastDone = [...steps].reverse().find((step) => step.state === "done");
  const failed = steps.find((step) => step.state === "failed");
  const failureEvent = [...currentEvents].reverse().find((event) => event.code.startsWith("run.failed"));
  const lines: string[] = [];
  if (lastDone) lines.push(loaderLine(lastDone, fmt));
  const label = (failureEvent && failureCopy(failureEvent.code)) ?? failed?.label ?? "Stopped";
  const at = failureEvent?.elapsedMs != null ? `  ${chip(elapsed(failureEvent.elapsedMs))}` : "";
  lines.push(`${fmt("cog_fail")} ${label}${at}`);
  return lines;
}
