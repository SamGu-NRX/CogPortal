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
 * nothing does. What it can say is what it saw, and the last two blocks are
 * the most literal form of that: the files it could not read, and the places
 * their own code raised while it was being called. Both are printed the way a
 * compiler prints them, because that is the form a programmer already knows
 * how to read.
 */
export interface Refusal {
  status: string;
  headline: string;
  nextStep: string;
  trace: { stage: string; function: string; received?: string; returned?: string }[];
  /** What the search learned that the headline does not say. */
  notes: string[];
  /** Files the run could not read, and whose problem each one is. */
  skipped: { module: string; reason: string; owner: string }[];
  /** Where their own code raised, inside their own repository. */
  errors: { file: string; line: number; function: string; message: string }[];
}

export function RefusalCard({ refusal }: { refusal: Refusal }) {
  const hasReport = refusal.skipped.length > 0 || refusal.errors.length > 0;

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
      {refusal.notes.map((note) => (
        // Prose, because a note is a sentence the search wrote about
        // something it worked out, and the headline could not carry it. On
        // one 2026 repository the note is the only actionable thing on the
        // page: a constructor reads a folder next to its own file.
        <p key={note} className="mt-3 max-w-prose text-[14px] leading-relaxed text-ink-secondary">
          {note}
        </p>
      ))}
      {hasReport && (
        <div className="mt-5 border border-rule bg-paper-sunken px-3.5 py-3">
          {refusal.skipped.length > 0 && (
            <>
              <h3 className="u-kicker">Could not read</h3>
              <ul className="mt-2 space-y-1 font-mono text-[12.5px] leading-[1.65] break-words text-ink-secondary">
                {refusal.skipped.map((file) => (
                  <li key={file.module}>
                    <span className="text-ink">{file.module}</span>: {file.reason}
                    {file.owner !== "theirs" && (
                      // Named only when it is not their fault. A module we
                      // skipped because this machine lacks a package the
                      // graded run installs is our absence, and letting it
                      // sit unlabelled beside a syntax error of theirs reads
                      // as one more thing they got wrong. Muted by size and
                      // case rather than by colour, which is how the rest of
                      // the interface marks a label, and which keeps it
                      // readable at this size.
                      <span className="text-[11px] tracking-[0.06em] uppercase">
                        {" "}
                        ({file.owner})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {refusal.errors.length > 0 && (
            <>
              <h3 className={refusal.skipped.length > 0 ? "u-kicker mt-4" : "u-kicker"}>
                Raised while trying
              </h3>
              <ul className="mt-2 space-y-1 font-mono text-[12.5px] leading-[1.65] break-words text-ink-secondary">
                {refusal.errors.map((error) => (
                  <li key={`${error.file}:${error.line}:${error.message}`}>
                    <span className="text-ink">
                      {/* No line when it would point nowhere. A notebook is
                          compiled from the cells that hold definitions, so
                          its line numbers count lines of that module rather
                          than of the .ipynb a team would open. */}
                      {error.line > 0 ? `${error.file}:${error.line}` : error.file}
                    </span>
                    : {error.message} (in {error.function})
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {refusal.trace.length > 0 && (
        <div className="mt-5 border-t border-rule-soft pt-4">
          <WiringTrace steps={refusal.trace} incomplete />
        </div>
      )}
    </Panel>
  );
}
