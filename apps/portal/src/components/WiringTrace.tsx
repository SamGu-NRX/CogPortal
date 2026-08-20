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
 * When the chain is incomplete, the same list is the most useful thing on the
 * page. It says how far the search got and what the next step was offered,
 * which is where a team should look first. It offers no diagnosis, because the
 * platform cannot know which of their lines is wrong and a confident wrong
 * guess costs more than silence.
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
      <div className="u-kicker">
        {incomplete ? "How far your code was followed" : "Your code, as it was run"}
      </div>
      <ol className="mt-3 space-y-2.5">
        {steps.map((step, index) => (
          <li key={`${index}:${step.function}`} className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
            <div className="pt-[0.15em] font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              {step.stage}
            </div>
            <div className="min-w-0">
              <div className="truncate font-mono text-[13px] text-ink">{step.function}</div>
              {(step.received || step.returned) && (
                // The shapes are the reproduction a team debugs from. They are
                // the platform's whole contribution to a chain that runs and
                // answers wrongly: what ran, on what, and what came back.
                <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-ink-faint">
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
