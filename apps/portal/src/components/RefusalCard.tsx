import { Panel } from "./Panel";
import { WiringTrace } from "./WiringTrace";

/**
 * Why the platform could not find code to score.
 *
 * A run that fails because their algorithm crashed has a traceback, and the
 * log is the right place for it. A run that fails because nothing in the
 * repository performed the week's task has no traceback at all, and the capped
 * failure line ("No adapter found in ...") tells a team nothing they can act
 * on. This is the other half of that: how far the search got, in their own
 * function names, and the one next thing to do.
 *
 * It offers no diagnosis. The platform cannot know which of their lines is
 * wrong, and a confident wrong guess costs a team more time than saying
 * nothing does. What it can say is what it saw.
 */
export interface Refusal {
  status: string;
  headline: string;
  nextStep: string;
  trace: { stage: string; function: string; received?: string; returned?: string }[];
}

export function RefusalCard({ refusal }: { refusal: Refusal }) {
  return (
    <Panel label="WHAT THE BENCHMARK LOOKED FOR">
      <p className="max-w-prose font-serif text-[17px] leading-[1.5] text-ink sm:text-[19px]">
        {refusal.headline}
      </p>
      {refusal.nextStep && (
        // Only ever present when the platform honestly knows it: a package it
        // can name, a file it could not read. Most refusals have none, and an
        // invented next step is worse than an absent one.
        <p className="mt-3 max-w-prose text-[14px] leading-relaxed text-ink-secondary">
          {refusal.nextStep}
        </p>
      )}
      {refusal.trace.length > 0 && (
        <div className="mt-5 border-t border-rule-soft pt-4">
          <WiringTrace steps={refusal.trace} incomplete />
        </div>
      )}
    </Panel>
  );
}
