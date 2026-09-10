import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState } from "react";
import type { ChurnEvent, StageActivity, TeamDetail, TeamProcessSignals } from "@cogworks/contracts/schema";
import { formatTimeAgo } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import { useTeamProcess } from "@/lib/queries";
import { LoadingMark, QueryError } from "./Feedback";
import { MemberAvatar } from "./MemberAvatar";
import { ShaChip } from "./ShaChip";

/**
 * The process layer, on the page where a team looks at itself.
 *
 * A score says how the pipeline did. These signals say where the work went
 * and when the pieces first fit together, which is the question the course
 * owner named and a leaderboard cannot answer (see
 * `docs/design/the-instrument-not-the-judge.md`, "The process layer").
 *
 * The constraint that shapes every decision below: no per-person totals, no
 * percentages, no badges, no ordering of members, anywhere. A stage says who
 * touched it, never how much. Anything that could be read as a grade by a
 * seventeen-year-old is not drawn, whatever caveat sits beside it.
 *
 * The second constraint came from a reader of the deployed version, who said
 * he could not tell what the panel was. Two things follow from that. The
 * title and the sentence under it stay outside the collapsing region, so a
 * closed panel still says what it reads and why; and there is no detector red
 * anywhere in here. Red in this system means a detection or a failure, and
 * nothing this panel reports is either, so the whole thing is drawn in rule,
 * paper, and ink, with one hairline accent reserved for the only finding that
 * asks a team to go and look at something.
 */
export function ProcessPanel({ members }: { members: TeamDetail["members"] }) {
  const process = useTeamProcess();
  const [open, setOpen] = useState(readStoredOpen);
  const reduced = useReducedMotion();
  const bodyId = useId();
  const descriptionId = useId();

  if (process.isError) {
    return (
      <div className="mt-4">
        <QueryError error={process.error} retry={() => void process.refetch()} />
      </div>
    );
  }

  const toggle = () => {
    setOpen((wasOpen) => {
      storeOpen(!wasOpen);
      return !wasOpen;
    });
  };

  // Panel's own chrome, rebuilt here because a Panel header cannot be a
  // button and this one has to be: the whole header row is the hit target.
  // If a second panel ever needs to collapse, that belongs in Panel.tsx.
  return (
    <section className="relative mt-4 border border-rule bg-paper-raised">
      <header className={open ? "border-b border-rule-soft" : undefined}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={descriptionId}
          className="group flex min-h-10 w-full items-center justify-between gap-3 px-4 pt-2.5 pb-1 text-left"
        >
          <h2 className="u-kicker group-hover:text-ink">Where the work went</h2>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
            className="shrink-0 text-ink-faint group-hover:text-ink"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={15} strokeWidth={1.8} />
          </motion.span>
        </button>
        {/* Outside the button, so a screen reader announces it as the
            control's description rather than as part of its name. */}
        <p
          id={descriptionId}
          className="max-w-[64ch] px-4 pb-2.5 font-serif text-[13px] leading-[1.55] text-ink-secondary"
        >
          We read your recent commits and your runs, so you can see which parts of the pipeline your
          team has been working in and when your pipeline first scored end to end.
        </p>
      </header>

      <div id={bodyId}>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={reduced ? { opacity: 1, height: "auto" } : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { height: 0, opacity: 0, transition: { duration: 0.16, ease: EASE_OUT } }
              }
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <div className="px-4 pt-3.5 pb-4">
                {process.data ? (
                  <Signals signals={process.data} members={members} />
                ) : (
                  <LoadingMark label="Reading commits and runs" />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

/* ── Remembering the panel's state ─────────────────────────────────────── */

const OPEN_KEY = "cogportal.process-panel.open";

/**
 * Open until the reader closes it, then closed for the rest of the session.
 *
 * Open is the default because a closed panel titled with three words is the
 * thing nobody ever opens, and this is the only place a team can see any of
 * this. Closing is remembered because a reader who has decided they don't
 * want it should not have to decide again on every navigation. Session, not
 * local, storage: the decision is about this sitting, and a team that opens
 * the portal next week should meet the panel again rather than a panel they
 * closed once in July.
 */
function readStoredOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true; // Storage can be blocked; the panel still works, it just forgets.
  }
}

function storeOpen(open: boolean): void {
  try {
    sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* see readStoredOpen */
  }
}

/* ── The body ──────────────────────────────────────────────────────────── */

function Signals({
  signals,
  members,
}: {
  signals: TeamProcessSignals;
  members: TeamDetail["members"];
}) {
  return (
    <div>
      <Findings sentences={signals.findingSentences} />
      <Stages signals={signals} members={members} />
      {/* Two conditions, for two different reasons. Churn is defined as
          "after the first scored run", so with no first run there is nothing
          to measure against. And the list is only evidence when the history
          it was derived from could actually be read: an empty list from a
          failed fetch means we do not know, and this section used to render
          "nothing has changed" for it. */}
      {signals.firstLight.firstScoredAt !== null && signals.historyQuality === "usable" && (
        <ContractFiles
          events={signals.boundaryChurn}
          firstScoredAt={signals.firstLight.firstScoredAt}
        />
      )}
      <p className="mt-5 border-t border-rule-soft pt-2 font-mono text-[10.5px] text-ink-faint">
        Read {formatTimeAgo(signals.computedAt)}
        {signals.historyWindow
          ? `, from your ${signals.historyWindow.truncated ? "most recent " : ""}${signals.historyWindow.commits} commit${signals.historyWindow.commits === 1 ? "" : "s"}`
          : ""}
        .
      </p>
    </div>
  );
}

/**
 * The readings, as lines rather than prose.
 *
 * Four at most (`MAX_FINDING_SENTENCES` in `process-signals.ts`), so this can
 * be a plain list with no lead sentence set apart from the rest. The first
 * line carries slightly more weight because it is always the frame the others
 * are read against: either the state of the history, or the first run that
 * scored. The marker is a hairline rather than a bullet, which is the rule
 * this design system already uses to mean "an entry in an instrument".
 */
function Findings({ sentences }: { sentences: string[] }) {
  if (sentences.length === 0) return null;

  return (
    <ul>
      {sentences.map((sentence, index) => (
        <li key={`${index}:${sentence}`} className="flex gap-3 pb-2 last:pb-0">
          <span aria-hidden="true" className="mt-[0.62em] h-px w-3 shrink-0 bg-ink-faint" />
          <span
            className={`max-w-[64ch] leading-[1.5] ${
              index === 0 ? "text-[13.5px] text-ink" : "text-[13px] text-ink-secondary"
            }`}
          >
            {sentence}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ── Stage footprint and ownership breadth, drawn as one thing ──────────
   They answer the same question from two sides: which people touched a
   stage, and when it was worked on. Drawn separately, a reader would have to
   join two lists by stage name to answer either. */

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
      <h3 className="u-kicker">Stages of the pipeline</h3>
      {/* No stages beats an unreadable history: with no scored run there is no
          stage map at all, so there is nothing for a history reason to be
          about. The findings above still carry that reason. */}
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
        <StageRail
          stages={stages}
          ownership={signals.ownershipBreadth}
          members={members}
          windowed={signals.historyWindow?.truncated === true}
        />
      )}
    </section>
  );
}

function StageRail({
  stages,
  ownership,
  members,
  windowed,
}: {
  stages: [string, StageActivity][];
  ownership: Record<string, string[]>;
  members: TeamDetail["members"];
  /** Older commits exist and were not read, so an absence here is an absence
   *  in what was read rather than in the project. */
  windowed: boolean;
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
      <ul className="mt-1">
        {stages.map(([stage, activity], index) => {
          const owners = ownership[stage] ?? [];
          const span =
            activity.firstTouchAt !== null && activity.lastTouchAt !== null
              ? { from: activity.firstTouchAt, to: activity.lastTouchAt }
              : null;
          // The two states worth a second look, said in words next to the
          // stage name so the column reads down as "here, here, and nowhere
          // else". Not a count, not a badge, not a comparison between people:
          // "one person" is the stage's bus factor, the same reading
          // `distinctAuthorCount` is allowed to be.
          // "yet" and "so far" both mean "in the whole history", which is not
          // what was read when older commits were left unrequested. Over a
          // window the same two states are true of the window and nothing
          // else, so the words say which.
          const flag =
            owners.length === 0
              ? windowed
                ? "no commits in these"
                : "no commits yet"
              : owners.length === 1
                ? windowed
                  ? "one person in these"
                  : "only one person so far"
                : null;
          // Asymmetric padding on purpose: a bar has to read as belonging to
          // the label above it, not to the one below.
          return (
            <li key={stage} className="pt-2 pb-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span
                    className={`font-mono text-[11.5px] tracking-[0.07em] uppercase ${
                      owners.length === 0 ? "text-ink-secondary" : "text-ink"
                    }`}
                  >
                    {stage}
                    {span && (
                      <span className="sr-only">
                        , worked {day(span.from)} to {day(span.to)}
                      </span>
                    )}
                  </span>
                  {flag && <span className="text-[12px] text-ink-secondary">{flag}</span>}
                </span>
                {owners.length > 0 && (
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
                )}
              </div>
              {/* A dashed track for a stage with nothing on it, so the gap
                  reads as "nothing recorded" rather than as a bar of zero
                  length that might just be too small to see. */}
              <span
                aria-hidden="true"
                className={`relative mt-1.5 block h-[3px] w-full ${
                  span ? "bg-rule-soft" : "border-t border-dashed border-rule"
                }`}
              >
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
      <div className="mt-1 flex items-baseline justify-between gap-3 font-mono text-[10.5px] text-ink-faint">
        <span className="u-tnum">{day(start)}</span>
        {/* Two bare dates are a mystery; on a phone there is no room to
            explain them, and the bars are still readable as a shared span. */}
        <span className="hidden sm:inline">
          each bar runs from that stage's first commit to its most recent
        </span>
        <span className="u-tnum">{day(end)}</span>
      </div>
    </>
  );
}

/* ── What the benchmark loads, and what has changed in it ──────────────── */

/** The list is evidence for the sentence above it, not a log; past a handful
 *  of rows a reader is scrolling rather than reading. */
const MAX_CHURN_ROWS = 5;

/**
 * Commits that touched a contract file after the first scored run.
 *
 * This is the one thing in the panel that asks a team to go and look at
 * something, so it is the one thing that carries an accent: a hairline rule
 * down the left of the list, and only when the list has something in it.
 *
 * Files are stacked one per row. Joined with commas they wrapped across three
 * lines and read as one alarming block of text rather than as four paths,
 * which is the opposite of what a list of evidence is for.
 */
function ContractFiles({
  events,
  firstScoredAt,
}: {
  events: ChurnEvent[];
  firstScoredAt: number;
}) {
  // Nothing to show is not a finding. The check looks at two conventional
  // adapter filenames, and a repository wired up automatically has neither, so
  // an empty list meant "we looked at two files you do not have" and the page
  // was rendering that as reassurance. The section appears when there is
  // something in it, and the paths come from the events themselves rather than
  // from a second copy of the list here.
  if (events.length === 0) return null;

  return (
    <section className="mt-5 border-t border-rule-soft pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="u-kicker">Adapter files changed</h3>
        <span className="u-tnum font-mono text-[10.5px] text-ink-faint">
          since your first scored run, {day(firstScoredAt)}
        </span>
      </div>
      {(
        <>
          <ul className="mt-2.5 border-l border-detect/45 pl-3">
            {events.slice(0, MAX_CHURN_ROWS).map((event) => (
              <li key={event.sha} className="border-b border-rule-soft pb-2.5 last:border-b-0 last:pb-0 [&+li]:pt-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ShaChip sha={event.sha} shortSha={event.sha.slice(0, 7)} />
                  <span className="u-tnum font-mono text-[11.5px] text-ink-faint">
                    {day(event.authoredAt)}
                  </span>
                </div>
                <ul className="mt-1.5">
                  {event.files.map((path) => (
                    <li
                      key={path}
                      className="font-mono text-[11.5px] leading-[1.6] break-all text-ink-secondary"
                    >
                      {path}
                    </li>
                  ))}
                </ul>
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
