import { motion, useReducedMotion } from "motion/react";
import type { ChurnEvent, StageActivity, TeamDetail, TeamProcessSignals } from "@cogworks/contracts/schema";
import { formatTimeAgo } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import { useTeamProcess } from "@/lib/queries";
import { CornerBrackets } from "./Brackets";
import { LoadingMark, QueryError } from "./Feedback";
import { MemberAvatar } from "./MemberAvatar";
import { Panel } from "./Panel";
import { ShaChip } from "./ShaChip";

/**
 * The process layer, on the page where a team looks at itself.
 *
 * A score says how the pipeline did. These four signals say where the work
 * went and when the pieces first fit together, which is the question the
 * course owner named and a leaderboard cannot answer (see
 * `docs/design/the-instrument-not-the-judge.md`, "The process layer").
 *
 * The constraint that shapes every decision below: no per-person totals, no
 * percentages, no badges, no ordering of members, anywhere. A stage says who
 * touched it, never how much. Anything that could be read as a grade by a
 * seventeen-year-old is not drawn, whatever caveat sits beside it.
 */
export function ProcessPanel({ members }: { members: TeamDetail["members"] }) {
  const process = useTeamProcess();

  if (process.isError) {
    return (
      <div className="mt-4">
        <QueryError error={process.error} retry={() => void process.refetch()} />
      </div>
    );
  }

  return (
    <Panel
      label="YOUR COMMITS AND RUNS"
      className="mt-4"
      aside={
        process.data ? (
          <span className="font-mono text-[11px] text-ink-faint">
            read {formatTimeAgo(process.data.computedAt)}
          </span>
        ) : undefined
      }
    >
      {process.data ? (
        <Signals signals={process.data} members={members} />
      ) : (
        <LoadingMark label="Reading commits and runs" />
      )}
    </Panel>
  );
}

function Signals({
  signals,
  members,
}: {
  signals: TeamProcessSignals;
  members: TeamDetail["members"];
}) {
  const [lead, ...rest] = signals.findingSentences;

  return (
    <div>
      {lead && (
        <figure className="relative py-1">
          <CornerBrackets size={14} thickness={1.5} inset={-8} className="text-detect" />
          <p className="max-w-[58ch] font-serif text-[17px] leading-[1.45] text-ink sm:text-[19px] sm:leading-[1.4]">
            {lead}
          </p>
          {rest.length > 0 && (
            <figcaption className="mt-3">
              <ul className="space-y-1.5">
                {rest.map((sentence, index) => (
                  <li
                    key={`${index}:${sentence}`}
                    className="flex gap-2.5 text-[13px] leading-relaxed text-ink-secondary"
                  >
                    <span aria-hidden="true" className="mt-[0.55em] size-1 shrink-0 bg-ink-faint" />
                    <span className="max-w-prose">{sentence}</span>
                  </li>
                ))}
              </ul>
            </figcaption>
          )}
        </figure>
      )}

      <Stages signals={signals} members={members} />
      <FirstRun firstLight={signals.firstLight} />
      {/* Churn is defined as "after first light", so with no first light there
          is nothing to report and nothing honest to say about it either. */}
      {signals.firstLight.firstScoredAt !== null && (
        <ContractChanges events={signals.boundaryChurn} />
      )}
    </div>
  );
}

/* ── Stage footprint and ownership breadth, drawn as one thing ──────────
   They answer the same question from two sides: a stage-wide count of the
   people who touched a stage, and their names. Drawn separately, the count
   would be the length of the list beside it. */

function Stages({
  signals,
  members,
}: {
  signals: TeamProcessSignals;
  members: TeamDetail["members"];
}) {
  const stages = Object.entries(signals.stageFootprint);
  const reason = stages.find(([, activity]) => activity.unavailableReason)?.[1].unavailableReason;

  return (
    <section className="mt-5 border-t border-rule-soft pt-3">
      <h3 className="u-kicker">Stages</h3>
      {/* No stages beats an unreadable history: with no scored run there is no
          stage map at all, so there is nothing for a history reason to be
          about. The finding sentences above still carry that reason. */}
      {stages.length === 0 ? (
        <p className="mt-2 max-w-prose text-[13px] text-ink-secondary">
          Stages appear here after a run scores. The run is what tells the portal which week's
          pipeline to read your files against.
        </p>
      ) : reason ? (
        <p className="mt-2 max-w-prose text-[13px] text-ink-secondary">
          Stages aren't shown here because {reason}.
        </p>
      ) : (
        <StageRail stages={stages} ownership={signals.ownershipBreadth} members={members} />
      )}
    </section>
  );
}

function StageRail({
  stages,
  ownership,
  members,
}: {
  stages: [string, StageActivity][];
  ownership: Record<string, string[]>;
  members: TeamDetail["members"];
}) {
  const reduced = useReducedMotion();

  // One axis for every stage, so the bars are comparable. A stage nobody has
  // touched contributes no time and simply draws nothing.
  const times = stages.flatMap(([, activity]) =>
    activity.firstTouchAt !== null && activity.lastTouchAt !== null
      ? [activity.firstTouchAt, activity.lastTouchAt]
      : [],
  );
  if (times.length === 0) {
    return (
      <p className="mt-2 max-w-prose text-[13px] text-ink-secondary">
        No commit has touched a stage file yet.
      </p>
    );
  }
  const start = Math.min(...times);
  const end = Math.max(...times);
  // A whole week's work can land on one day, and then every bar would be at
  // the same point with a zero-width span to divide by.
  const width = end - start || 1;
  const at = (epochMs: number) => ((epochMs - start) / width) * 100;

  return (
    <>
      {/* Stage-map order, which is pipeline order, so reading down the rail
          is reading along the pipeline. */}
      <ul className="mt-2">
        {stages.map(([stage, activity], index) => {
          const owners = ownership[stage] ?? [];
          const span =
            activity.firstTouchAt !== null && activity.lastTouchAt !== null
              ? { from: activity.firstTouchAt, to: activity.lastTouchAt }
              : null;
          // Asymmetric padding on purpose: a bar has to read as belonging to
          // the label above it, not to the one below.
          return (
            <li key={stage} className="pt-1.5 pb-4">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="font-mono text-[11.5px] tracking-[0.07em] text-ink uppercase">
                  {stage}
                  {span && (
                    <span className="sr-only">
                      , worked {day(span.from)} to {day(span.to)}
                    </span>
                  )}
                </span>
                {owners.length > 0 ? (
                  <span className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
                    {owners.map((login) => (
                      <span key={login} className="flex items-center gap-1.5">
                        <MemberAvatar
                          login={login}
                          avatarUrl={avatarFor(members, login)}
                          className="size-5"
                        />
                        <span className="font-mono text-[11.5px] text-ink-secondary">{login}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-[12px] text-ink-faint">no commits yet</span>
                )}
              </div>
              <span aria-hidden="true" className="relative mt-1 block h-[3px] w-full bg-rule-soft">
                {span && (
                  <motion.span
                    className="absolute inset-y-0 block min-w-[3px] origin-left bg-ink"
                    style={{ left: `${at(span.from)}%`, width: `${at(span.to) - at(span.from)}%` }}
                    initial={reduced ? false : { scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.26, ease: EASE_OUT, delay: index * 0.04 }}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 flex items-baseline justify-between font-mono text-[10.5px] text-ink-faint">
        <span>{day(start)}</span>
        <span>{day(end)}</span>
      </div>
    </>
  );
}

/* ── First light, and what changed after it ────────────────────────────── */

/** The list is evidence for the sentence above it, not a log; past a handful
 *  of rows a reader is scrolling rather than reading. */
const MAX_CHURN_ROWS = 5;

function FirstRun({ firstLight }: { firstLight: TeamProcessSignals["firstLight"] }) {
  const { firstScoredAt, scoredRunCount } = firstLight;

  return (
    <section className="mt-5 border-t border-rule-soft pt-3">
      <h3 className="u-kicker">First end-to-end run</h3>
      {firstScoredAt === null ? (
        <p className="mt-1 text-[13px] text-ink-faint">Not yet.</p>
      ) : (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="u-tnum font-mono text-[13px] text-ink">{day(firstScoredAt)}</span>
          <span className="text-[12.5px] text-ink-faint">
            {scoredRunCount} scored run{scoredRunCount === 1 ? "" : "s"} since
          </span>
        </p>
      )}
    </section>
  );
}

/** No rule above it: these commits are read against the first run stated
 *  directly overhead, so the two belong to one another. */
function ContractChanges({ events }: { events: ChurnEvent[] }) {
  return (
    <section className="mt-4">
      <h3 className="u-kicker">Contract file changes</h3>
      {events.length === 0 ? (
        <p className="mt-1 max-w-prose text-[13px] text-ink-secondary">
          Nothing has changed submission.py or benchmark_adapter.py since that run.
        </p>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-rule-soft">
            {events.slice(0, MAX_CHURN_ROWS).map((event) => (
              <li key={event.sha} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
                <ShaChip sha={event.sha} shortSha={event.sha.slice(0, 7)} />
                <span className="u-tnum font-mono text-[11.5px] text-ink-faint">
                  {day(event.authoredAt)}
                </span>
                <span className="font-mono text-[11.5px] text-ink-secondary">
                  {event.files.join(", ")}
                </span>
              </li>
            ))}
          </ul>
          {events.length > MAX_CHURN_ROWS && (
            <p className="mt-2 text-[12px] text-ink-faint">
              {events.length - MAX_CHURN_ROWS} more since then.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

/**
 * Dates read in UTC because the finding sentences above them are formatted
 * that way (`process-signals.ts`, `formatDate`). Left to the local zone,
 * the same instant would print as two different days on one screen.
 */
function day(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A login here is whoever the commit history names, which is not always a
 * portal account: a git author with no linked GitHub user arrives under
 * their git name. Those people have no avatar, and the initial-letter box
 * is the honest rendering.
 */
function avatarFor(members: TeamDetail["members"], login: string): string | null {
  return members.find((member) => member.login === login)?.avatarUrl ?? null;
}
