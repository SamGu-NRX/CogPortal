import type { ReactNode } from "react";
import type { Module, RunFailure, RunMode } from "@cogworks/contracts/schema";
import { resolveFailureCopy } from "@cogworks/contracts/failures";
import { PHASE_LABELS } from "@/lib/run-meta";
import { Code } from "./Code";
import { Panel } from "./Panel";
import { RefusalCard, type Refusal } from "./RefusalCard";
import { Veil } from "./Veil";

/**
 * A failed run, told in the order a student needs it: what happened, the
 * benchmark's own note on it, and one thing to do next. Everything else
 * (the longer explanation, the log, anything the run saved before it
 * stopped) is under "Show details", reversible, so the card opens on the
 * three lines that matter.
 *
 * Which next action is offered follows the catalog's `retryable` flag, which
 * says whether running the same commit again can answer differently:
 *
 * - Not retryable means the cause is in the submission (an exception, a bad
 *   output shape, a timeout). Running it again would fail the same way, so the
 *   next action is the catalog's local reproduction, and the runner's detail
 *   line is shown open because it is the evidence the student debugs from.
 * - Retryable means the cause was on the platform's side or in a cache. The
 *   next action is the caller's `next` (the run's console, which can run it
 *   again), and the catalog's escalation to staff waits in the details rather
 *   than being the first thing a student is told to do.
 *
 * A refusal replaces the title and detail with the refusal itself, which says
 * the same thing in the team's own function names.
 */
export function FailureCard({
  failure,
  mode,
  benchmarkId,
  module,
  refusal,
  collapsed = false,
  next,
  children,
}: {
  failure: RunFailure | null;
  mode: RunMode;
  benchmarkId: string;
  /** The base copy remains valid while the benchmark list loads. */
  module?: Module;
  refusal?: Refusal | null;
  collapsed?: boolean;
  /** The next action for a failure the platform can try again, such as a link
   *  to the run's console. Ignored when the cause is in the submission. */
  next?: ReactNode;
  /** Evidence belonging to this failed physical execution, never current results. */
  children?: ReactNode;
}) {
  const copy = failure ? resolveFailureCopy(failure.category, { benchmarkId, module }) : null;

  if (collapsed) {
    return (
      <span className="font-mono text-[12.5px] text-ink-secondary">
        {copy?.code ?? "Run failed"} · {mode}
      </span>
    );
  }

  const ours = Boolean(copy?.retryable);
  const stage = failure ? PHASE_LABELS[failure.phase] : null;
  // The detail is the runner's one line about this execution. For a failure
  // in the submission it is the exception or the offending value, and it is
  // shown; for one on our side it is machinery, and it waits in the details.
  const openDetail = !refusal && !ours && failure?.detail ? failure.detail : null;
  const hasDetails = Boolean(copy && !refusal) || Boolean(children);

  return (
    <Panel tone="alert">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13.5px] font-semibold text-detect-deep">
          Run failed
          {stage && !refusal && <span className="font-normal"> · stopped at {stage}</span>}
        </p>
        {copy && !refusal && (
          <span className="font-mono text-[12px] text-ink-secondary">{copy.code}</span>
        )}
      </div>

      {refusal ? (
        <div className="mt-3">
          <RefusalCard
            refusal={refusal}
            benchmarkId={benchmarkId}
            stage={stage ?? undefined}
            aside={failure ? <FailureCard failure={failure} mode={mode} benchmarkId={benchmarkId} collapsed /> : undefined}
          />
        </div>
      ) : (
        copy && (
          <>
            <h2 className="mt-1.5 max-w-[36rem] font-serif text-[24px] leading-[1.25] text-ink sm:text-[28px]">
              {copy.title}
            </h2>
            {ours && (
              <p className="mt-2 max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
                {copy.explanation}
              </p>
            )}
            {openDetail && (
              <pre className="mt-3 max-h-80 overflow-auto rounded-control border border-detect/20 bg-paper-raised px-3.5 py-2.5 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink">
                {openDetail}
              </pre>
            )}
            {!ours ? (
              <div className="mt-5">
                <p className="u-label">Next step</p>
                <p className="mt-1 max-w-[60ch] text-[14.5px] leading-[1.55] break-words whitespace-pre-wrap text-ink">
                  {copy.action}
                </p>
                {copy.reproCommand && (
                  <div className="mt-2.5">
                    <Code code={copy.reproCommand} lang="bash" wrap />
                  </div>
                )}
              </div>
            ) : (
              next && <div className="mt-4">{next}</div>
            )}
          </>
        )
      )}

      {hasDetails && (
        <div className="mt-5">
          <Veil count={1} peek={0} moreLabel="Show details" fewerLabel="Hide details">
            {copy && !refusal && (
              <div className="space-y-3">
                {!ours && (
                  <p className="max-w-[60ch] text-[14px] leading-[1.55] text-ink-secondary">
                    {copy.explanation}
                  </p>
                )}
                {ours && failure?.detail && (
                  <pre className="max-h-80 overflow-auto rounded-control border border-rule bg-paper-sunken px-3 py-2 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink">
                    {failure.detail}
                  </pre>
                )}
                {ours && (
                  <p className="max-w-[60ch] text-[14px] leading-[1.55] break-words whitespace-pre-wrap text-ink">
                    {copy.action}
                  </p>
                )}
                {ours && copy.reproCommand && <Code code={copy.reproCommand} lang="bash" wrap />}
              </div>
            )}
            {children}
          </Veil>
        </div>
      )}
    </Panel>
  );
}
