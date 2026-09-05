import { Fragment, type ReactNode } from "react";
import { Panel } from "./Panel";
import { WiringTrace } from "./WiringTrace";

/**
 * Why the platform could not find code to score, set the way a compiler sets a
 * diagnostic: one label column, one observation per row, and no row at all
 * where the payload has nothing to put in it.
 *
 * It offers no diagnosis. The platform cannot know which of their lines is
 * wrong, and a confident wrong guess costs a team more time than saying
 * nothing does. Two tokens are printed in ink: where the run stopped, and the
 * exception class an import raised. Everything else is context for those two
 * and is set in ink-secondary, so the card has exactly as many focal points as
 * it has facts a team can act on.
 */
export interface Refusal {
  status: string;
  /** One sentence naming the hand-off that failed. It is the only place the
   *  stage the run wanted is named at all, so it leads. */
  headline: string;
  nextStep: string;
  trace: { stage: string; function: string; received?: string; returned?: string }[];
  /** Not rendered, for the same reason as `headline`. */
  notes: string[];
  /** Files the run could not read, and whose problem each one is. */
  skipped: { module: string; reason: string; owner: string }[];
  /** Where their own code raised, inside their own repository. */
  errors: { file: string; line: number; function: string; message: string }[];
}

/**
 * The exception class at the head of a message, when there is one.
 *
 * A skipped module's reason is either a Python exception line
 * ("FileNotFoundError: 'song_list'") or an observation in words ("is empty").
 * Only the first has a class, and the second gets none rather than a guess.
 */
export function errorClass(message: string): string | null {
  return /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))\b/.exec(message)?.[1] ?? null;
}

/**
 * The one line of advice a failed import earns, decided by its exception class
 * alone.
 *
 * Both cases below have the same mechanical cause: work that belongs inside a
 * function ran while the module was being read, so importing the module did
 * something it should only do when called. That is a fix a team can apply
 * without knowing anything else about their code. Every other class returns
 * null, including an empty module, because a wrong fix sends a team somewhere
 * an absent one does not.
 *
 * Templated client-side and never sent by the runner: the runner reports what
 * it saw, and this maps a class we recognize onto the edit that answers it.
 */
export function refusalFix(reason: string): string | null {
  const cls = errorClass(reason);
  if (cls === "RuntimeError" && /microphone|record/i.test(reason)) {
    return "move the microphone call out of module scope";
  }
  if (cls === "FileNotFoundError") {
    return "open the file inside the function, not at import";
  }
  return null;
}

/**
 * The pipeline stage the run could not fill, read out of the headline.
 *
 * There is no field for it. `cogbench.verdict` writes the stage into the
 * not_wired sentence and nowhere else, in one of two forms: "for the {stage}
 * step, which is what X returned" and "the input the {stage} step passes"
 * (`python/cogbench/src/cogbench/verdict.py:389` and `:397`). Both put the
 * name between "the" and "step", which is what this reads. A headline of any
 * other shape returns null and the header falls back to the run phase, so a
 * new verdict wording degrades to a coarser true answer rather than a wrong
 * one.
 */
export function stageFromHeadline(headline: string): string | null {
  return /the (\S+) step/.exec(headline)?.[1] ?? null;
}

/** The exception class in ink, the rest of the line as it was reported. */
function Raised({ message }: { message: string }) {
  const cls = errorClass(message);
  if (!cls) return <>{message}</>;
  return (
    <>
      <span className="text-ink">{cls}</span>
      {message.slice(cls.length)}
    </>
  );
}

export function RefusalCard({
  refusal,
  benchmarkId,
  stage,
  aside,
}: {
  refusal: Refusal;
  /** For the one command a team can run next. */
  benchmarkId: string;
  /** Where the run stopped, from the failure's phase. */
  stage?: string;
  /** The failure, collapsed to a line: category, mode, what it cost. */
  aside?: ReactNode;
}) {
  // The last hand-off the search completed. Everything after it is what the
  // platform could not find, and the rows that would have named the shape it
  // wanted next have no field in the payload to read.
  const lastReturn = [...refusal.trace].reverse().find((step) => step.returned);
  // The stage the run wanted, when the headline names it; otherwise the phase
  // the page read off the failure. "REFUSED AT DATABASE" tells a team which
  // hand-off to go look at; "REFUSED AT CONTRACT CHECK" only tells them when.
  const refusedAt = stageFromHeadline(refusal.headline) ?? stage;

  return (
    <Panel>
      <div className="font-mono text-[12.5px] leading-[1.7] text-ink-secondary">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="font-mono text-[12.5px] font-normal tracking-[0.08em] uppercase">
            refused
            {refusedAt ? <> at <span className="text-ink">{refusedAt}</span></> : null}
          </h2>
          {aside}
        </div>

        {refusal.headline && (
          <p className="mt-3 break-words text-ink">{refusal.headline}</p>
        )}

        <dl className="mt-4 grid grid-cols-[9ch_minmax(0,1fr)] gap-x-[1ch] gap-y-2">
          {lastReturn && (
            <>
              <dt>after</dt>
              <dd className="min-w-0 break-words">
                {lastReturn.function} returned {lastReturn.returned}
              </dd>
            </>
          )}

          {refusal.skipped.length > 0 && (
            <>
              <dt>not read</dt>
              <dd className="min-w-0">
                {refusal.skipped.length === 1
                  ? "1 module, which may hold what the run looked for"
                  : `${refusal.skipped.length} modules, any of which may hold what the run looked for`}
                <div className="mt-1.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[2ch] gap-y-1.5">
                  {refusal.skipped.map((file, index) => {
                    const fix = refusalFix(file.reason);
                    return (
                      <Fragment key={`${file.module}:${index}`}>
                        <div className="break-words">{file.module}</div>
                        <div className="min-w-0 break-words">
                          <Raised message={file.reason} />
                          {file.owner !== "theirs" && (
                            // Named only when it is not their fault. A module
                            // skipped because this machine lacks a package the
                            // graded run installs is our absence, and letting
                            // it sit unlabelled beside a syntax error of theirs
                            // reads as one more thing they got wrong.
                            <span className="text-[11px] tracking-[0.06em] uppercase">
                              {" "}
                              ({file.owner})
                            </span>
                          )}
                          {fix && (
                            <div className="mt-0.5 flex gap-x-[2ch]">
                              <span className="tracking-[0.06em] uppercase">fix</span>
                              <span className="min-w-0 break-words">{fix}</span>
                            </div>
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              </dd>
            </>
          )}

          {refusal.errors.length > 0 && (
            <>
              <dt>raised</dt>
              <dd className="min-w-0">
                <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[2ch] gap-y-1.5">
                  {refusal.errors.map((error) => (
                    <Fragment key={`${error.file}:${error.line}:${error.message}`}>
                      <div className="break-words">
                        {/* No line when it would point nowhere. A notebook is
                            compiled from the cells that hold definitions, so
                            its line numbers count lines of that module rather
                            than of the .ipynb a team would open. */}
                        {error.line > 0 ? `${error.file}:${error.line}` : error.file}
                      </div>
                      <div className="min-w-0 break-words">
                        <Raised message={error.message} />
                        {error.function && <> (in {error.function})</>}
                      </div>
                    </Fragment>
                  ))}
                </div>
              </dd>
            </>
          )}

          <dt>next</dt>
          <dd className="min-w-0 break-words">
            {/* Present only when the platform honestly knows it: a package it
                can name, a file it could not read. Most refusals have none,
                and an invented next step is worse than an absent one. */}
            {refusal.nextStep && <div>{refusal.nextStep}</div>}
            <div className={refusal.nextStep ? "mt-1" : ""}>
              cogworks check --benchmark {benchmarkId} --update-setup
            </div>
          </dd>
        </dl>
      </div>

      {refusal.trace.length > 0 && (
        <div className="mt-5 border-t border-rule-soft pt-4">
          <WiringTrace steps={refusal.trace} incomplete />
        </div>
      )}
    </Panel>
  );
}
