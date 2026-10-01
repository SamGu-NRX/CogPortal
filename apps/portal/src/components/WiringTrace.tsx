/**
 * Which of a team's own functions the platform ran, in the order it ran them.
 *
 * Nothing in a 2026 repository says which function is the peak finder. The
 * platform works it out by calling their functions and passing each one's real
 * output to the next, and it keeps a chain only when that chain enrolls two
 * songs and names the right one back. That inference is the thing a score now
 * rests on, so it is shown rather than assumed: a team can read this and see
 * whether we ran the code they think we ran.
 *
 * When the chain is incomplete, the same list says how far the search got and
 * what the next step was offered, which is where a team should look first. It
 * offers no diagnosis: the platform cannot know which of their lines is wrong,
 * and a confident wrong guess costs more than silence.
 */
export interface WiredStep {
  /** The benchmark's name for this step: "peaks", or "spectrogram + peaks"
   *  when one of their functions did two. */
  stage: string;
  /** Their function, as `module.function`. */
  function: string;
  /** What it was handed, in plain words: "an array of shape (1025, 171)". */
  received?: string;
  /** What it returned, in the same form. */
  returned?: string;
}

export function WiringTrace({
  steps,
  incomplete,
}: {
  steps: WiredStep[];
  /** True when the search stopped before the pipeline was complete. Changes
   *  the heading, because "wired up" would be claiming too much. */
  incomplete?: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <div>
      <div className="u-label">
        {incomplete ? "How far your code was followed" : "Your code, as it was run"}
      </div>
      {/* An ordered list on one rule, because it is a real sequence: each
          function was handed what the one before it returned. */}
      <ol className="mt-3 border-l border-rule pl-4">
        {steps.map((step, index) => (
          <li
            key={`${index}:${step.function}`}
            className="relative grid gap-x-5 gap-y-0.5 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
          >
            {/* A tick on the rule for each hand-off, like a pencil mark on a
                margin line. */}
            <span aria-hidden="true" className="absolute top-[1.05em] -left-4 h-px w-2.5 bg-rule-strong" />
            <div className="text-[13.5px] text-ink-secondary">{step.stage}</div>
            <div className="min-w-0">
              <div className="break-all font-mono text-[13px] text-ink">{step.function}</div>
              {(step.received || step.returned) && (
                // The shapes are the reproduction a team debugs from. They are
                // the platform's whole contribution to a chain that runs and
                // answers wrongly: what ran, on what, and what came back.
                <div className="mt-0.5 font-mono text-[12px] leading-relaxed text-ink-faint">
                  {step.received && <span>took {step.received}</span>}
                  {step.received && step.returned && <span aria-hidden="true"> · </span>}
                  {step.returned && <span>returned {step.returned}</span>}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
