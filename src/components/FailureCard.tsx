import type { RunFailure, RunMode } from "@shared/schema";
import { FAILURE_CATALOG } from "@shared/failures";
import { PHASE_LABELS } from "@/lib/run-meta";
import { CopyBlock } from "./CopyBlock";
import { Panel } from "./Panel";

/**
 * Failure is a first-class state (plan §8): failed phase, stable code,
 * plain-language explanation, the exact corrective action, a copyable local
 * reproduction, and whether an official attempt was consumed. Never
 * "Something went wrong".
 */
export function FailureCard({
  failure,
  mode,
}: {
  failure: RunFailure;
  mode: RunMode;
}) {
  const copy = FAILURE_CATALOG[failure.category];

  return (
    <Panel
      tone="alert"
      label={`FAILED DURING ${PHASE_LABELS[failure.phase].toUpperCase()}`}
      aside={
        <span className="bg-detect px-1.5 py-0.5 font-mono text-[11px] font-medium tracking-[0.08em] text-paper-raised">
          {copy.code}
        </span>
      }
    >
      <h3 className="font-serif text-xl font-semibold text-ink">{copy.title}</h3>
      <p className="mt-2 max-w-prose text-[14px] text-ink-secondary">
        {copy.explanation}
      </p>

      {failure.detail && (
        <pre className="mt-3 overflow-x-auto border border-rule bg-paper-sunken px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
          {failure.detail}
        </pre>
      )}

      <div className="mt-4">
        <div className="u-kicker">What to do</div>
        <p className="mt-1 max-w-prose text-[14px] whitespace-pre-wrap text-ink">
          {copy.action}
        </p>
      </div>

      {copy.reproCommand && (
        <div className="mt-4">
          <div className="u-kicker">Reproduce locally</div>
          <CopyBlock className="mt-1.5" text={copy.reproCommand} />
        </div>
      )}

      {mode === "official" && (
        <p
          className={`mt-4 border-t border-rule-soft pt-3 font-mono text-[11.5px] tracking-[0.05em] uppercase ${
            failure.consumedAttempt ? "text-detect-deep" : "text-verify-deep"
          }`}
        >
          {failure.consumedAttempt
            ? "This failure consumed one official attempt."
            : "No official attempt was consumed."}
        </p>
      )}
    </Panel>
  );
}
