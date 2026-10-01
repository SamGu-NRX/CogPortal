import type { PhaseTiming, RunFailure, RunStatus } from "@cogworks/contracts/schema";
import { RUN_PHASES } from "@cogworks/contracts/schema";
import { formatDurationMs } from "@/lib/format";
import { PHASE_LABELS, currentPhaseIndex, isTerminal } from "@/lib/run-meta";
import { CornerBrackets } from "./Brackets";

type NodeState = "done" | "current" | "failed" | "pending";

/**
 * The run pipeline rail (plan §8):
 * Queued → Prepare → Install → Contract check → Evaluate → Score → Complete.
 * Horizontal instrument scale on wide screens, a compact table on narrow
 * ones. Movement is restrained ease-in-out fill; the current node carries the
 * detection brackets. Labels are sentence case: they name stages, and the
 * stencil look of the old uppercase labels read as machine output.
 */
export function PhaseRail({
  status,
  failure,
  phases,
  showTimings = false,
}: {
  status: RunStatus;
  failure: RunFailure | null;
  phases?: PhaseTiming[];
  showTimings?: boolean;
}) {
  const current = currentPhaseIndex(status, failure?.phase);
  const failed = status === "failed";
  const done = status === "succeeded";

  const timingFor = (phase: string): string | null => {
    if (!showTimings || !phases) return null;
    const t = phases.find((p) => p.phase === phase);
    if (!t || t.startedAt == null || t.endedAt == null) return null;
    return formatDurationMs(t.endedAt - t.startedAt);
  };

  const stateFor = (i: number): NodeState => {
    if (failed && i === current) return "failed";
    if (i < current) return "done";
    if (i === current && !isTerminal(status)) return "current";
    if (i <= current && done) return "done";
    return "pending";
  };

  const srState: Record<NodeState, string> = {
    done: "complete",
    current: "in progress",
    failed: "failed",
    pending: "not started",
  };

  return (
    // A table on a phone, one stage per line with its time at the right; a
    // scale from 640px. The phone version used to stack each time under its
    // label, which made the rail the tallest thing on a failed run's page.
    <ol
      aria-label="Run pipeline"
      className="flex flex-col sm:flex-row sm:items-start"
    >
      {RUN_PHASES.map((phase, i) => {
        const state = stateFor(i);
        const timing = timingFor(phase);
        return (
          <li
            key={phase}
            aria-current={state === "current" ? "step" : undefined}
            className="relative flex min-h-8 items-center gap-3 sm:min-h-0 sm:flex-1 sm:flex-col sm:items-stretch sm:gap-0"
          >
            {/* The stem joining this stage to the next on a phone. */}
            <span
              aria-hidden="true"
              className={`absolute top-[calc(50%+7px)] left-[9.5px] h-[calc(100%-14px)] w-px sm:hidden ${
                i < current || done ? "bg-ink/70" : "bg-rule"
              }`}
            />
            <div className="flex items-center sm:w-full">
              <RailNode state={state} />
              {/* connector to the next node (from 640px) */}
              <span
                aria-hidden="true"
                className="mx-1.5 hidden h-px flex-1 bg-rule sm:block"
              >
                <span
                  className={`rail-fill block h-px ${failed && i >= current ? "bg-rule" : "bg-ink"}`}
                  style={{ transform: `scaleX(${i < current || done ? 1 : 0})` }}
                />
              </span>
            </div>
            <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3 sm:mt-2 sm:block sm:pr-3">
              <span
                className={`block text-[13.5px] leading-tight ${
                  state === "failed"
                    ? "font-semibold text-detect-deep"
                    : state === "current"
                      ? "font-semibold text-ink"
                      : state === "done"
                        ? "text-ink-secondary"
                        : "text-ink-faint"
                }`}
              >
                {PHASE_LABELS[phase]}
                <span className="sr-only">, {srState[state]}</span>
              </span>
              {timing && (
                <span className="u-tnum block font-mono text-[12px] text-ink-faint sm:mt-1">
                  {timing}
                </span>
              )}
            </div>
          </li>
        );
      })}

      {/* Terminal node: Complete */}
      <li className="flex min-h-8 items-center gap-3 sm:min-h-0 sm:flex-none sm:flex-col sm:items-stretch sm:gap-0">
        <RailNode state={done ? "done" : "pending"} terminal />
        <span
          className={`text-[13.5px] leading-tight sm:mt-2 ${
            done ? "font-semibold text-verify-deep" : "text-ink-faint"
          }`}
        >
          Complete
        </span>
      </li>
    </ol>
  );
}

function RailNode({
  state,
  terminal = false,
}: {
  state: NodeState;
  terminal?: boolean;
}) {
  return (
    <span className="relative z-[1] inline-flex size-5 shrink-0 items-center justify-center">
      {state === "current" && (
        <CornerBrackets size={6} thickness={1.5} inset={-3} className="text-detect" />
      )}
      {state === "failed" ? (
        <span className="flex size-[13px] items-center justify-center rounded-[2px] bg-detect">
          <svg viewBox="0 0 8 8" className="size-2 text-paper-raised" aria-hidden="true">
            <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
      ) : state === "done" && terminal ? (
        <span className="flex size-[13px] items-center justify-center rounded-[2px] bg-verify">
          <svg viewBox="0 0 8 8" className="size-2 text-paper-raised" aria-hidden="true">
            <path d="M1 4.2 L3.2 6.4 L7 1.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </svg>
        </span>
      ) : (
        <span
          className={`size-[11px] rounded-[2px] transition-colors duration-200 ${
            state === "done"
              ? "bg-ink"
              : state === "current"
                ? "anim-live border-[1.5px] border-detect bg-detect/20"
                : "border border-rule-strong bg-paper-raised"
          }`}
        />
      )}
    </span>
  );
}
