import type { ReactNode } from "react";
import type { Module, RunFailure, RunMode } from "@cogworks/contracts/schema";
import { resolveFailureCopy } from "@cogworks/contracts/failures";
import { PHASE_LABELS } from "@/lib/run-meta";
import { CopyBlock } from "./CopyBlock";
import { Panel } from "./Panel";
import { RefusalCard, type Refusal } from "./RefusalCard";
import { Veil } from "./Veil";

export function FailureCard({
  failure,
  mode,
  benchmarkId,
  module,
  refusal,
  collapsed = false,
  children,
}: {
  failure: RunFailure | null;
  mode: RunMode;
  benchmarkId: string;
  /** The base copy remains valid while the benchmark list loads. */
  module?: Module;
  refusal?: Refusal | null;
  collapsed?: boolean;
  /** Evidence belonging to this failed physical execution, never current results. */
  children?: ReactNode;
}) {
  const copy = failure ? resolveFailureCopy(failure.category, { benchmarkId, module }) : null;
  const reason = refusal?.headline || copy?.title;

  if (collapsed) {
    return (
      <span className="font-mono text-[12.5px] text-ink-secondary">
        {copy?.code ?? "Run failed"} · {mode}
      </span>
    );
  }

  return (
    <Panel tone="alert">
      <h3 className="font-serif text-xl font-semibold text-ink">Run failed</h3>
      {reason && (
        <p className="mt-2 max-w-prose break-words text-[14px] text-ink-secondary">{reason}</p>
      )}
      {(failure || refusal || children) && (
        <div className="mt-4">
          <Veil count={1} peek={0} moreLabel="Show details" fewerLabel="Hide details">
            {failure && copy && (
              <>
                <p className="font-mono text-[11px] text-ink-secondary">
                  {copy.code} · {PHASE_LABELS[failure.phase]}
                </p>
                <p className="max-w-prose text-[13px] text-ink-secondary">{copy.explanation}</p>
                {failure.detail && (
                  <pre className="max-h-80 overflow-auto border border-rule bg-paper-sunken px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                    {failure.detail}
                  </pre>
                )}
              </>
            )}
            {refusal && (
              <RefusalCard refusal={refusal} benchmarkId={benchmarkId} stage={failure ? PHASE_LABELS[failure.phase] : undefined} />
            )}
            {!refusal && copy?.action && (
              <p className="max-w-prose break-words text-[13px] whitespace-pre-wrap text-ink">{copy.action}</p>
            )}
            {copy?.reproCommand && (
              <div>
                <div className="u-kicker">Reproduce locally</div>
                <CopyBlock className="mt-1.5" text={copy.reproCommand} />
              </div>
            )}
            {children}
          </Veil>
        </div>
      )}
    </Panel>
  );
}
