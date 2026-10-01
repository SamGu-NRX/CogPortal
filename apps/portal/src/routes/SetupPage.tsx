import { ArrowRight01Icon, ArrowUpRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  isSelfCheckableStep,
  type SetupStep,
  type TeamDetail,
  type TeamMember,
} from "@cogworks/contracts/schema";
import { Button, buttonClass } from "@/components/Button";
import { Code } from "@/components/Code";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyBlock } from "@/components/CopyBlock";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Annotated, PageHeader } from "@/components/Note";
import { Panel } from "@/components/Panel";
import { Step, StepCells, StepRail, type StepState } from "@/components/StepRail";
import { TrackSwitcher } from "@/components/TrackSwitcher";
import {
  useConnections,
  useResetSetupState,
  useSession,
  useSetupState,
  useTeam,
} from "@/lib/queries";
import { benchmarkEnvironment } from "@/lib/benchmark-packages";
import { useTrack } from "@/lib/track";
import {
  clearSetupProgress,
  nextSetupLine,
  setupCommandProgress,
  setupCommandsForTeam,
  setupStepTitle,
  stepState,
  type SetupCommandId,
} from "@/lib/setup-progress";

/**
 * How a student reached this page, when it was the step that made their team.
 * ConnectPage sends it as router state after a team is created or joined.
 */
type Arrival = "created" | "joined";

function readArrival(state: unknown): Arrival | null {
  if (!state || typeof state !== "object" || !("arrivedFrom" in state)) return null;
  const from = state.arrivedFrom;
  return from === "created" || from === "joined" ? from : null;
}

export function SetupPage() {
  const team = useTeam();
  const { data: session } = useSession();
  const location = useLocation();
  const navigate = useNavigate();

  // The acknowledgement is for the moment the team came to exist, so it is
  // read once and then taken out of history. Router state lives in
  // history.state, which a reload keeps; left there, every refresh of this
  // page would announce the team again.
  const [arrival] = useState(() => readArrival(location.state));
  useEffect(() => {
    if (location.state == null) return;
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [location, navigate]);

  if (team.isPending || !session?.user) return <LoadingMark label="Loading your team" />;
  if (team.isError) {
    return (
      <div className="py-14">
        <QueryError error={team.error} retry={() => void team.refetch()} />
      </div>
    );
  }

  return (
    <SetupGuide
      team={team.data}
      login={session.user.login}
      arrival={arrival}
      devTools={session.auth.onboardingDevToolsEnabled && session.user.isOwner}
    />
  );
}

/**
 * The setup guide: one page from "you have a team" to "the tool called your
 * code", as a numbered rail a student works down.
 *
 * Every tick is something CogPortal was told by the student's own terminal. A
 * command reports through the device you linked, so a box fills because
 * evidence arrived, never because the page was told to believe something.
 */
function SetupGuide({
  team,
  login,
  arrival,
  devTools,
}: {
  team: TeamDetail;
  login: string;
  arrival: Arrival | null;
  devTools: boolean;
}) {
  // The commands below have to name a real benchmark, and the entry points a
  // student must register are whatever this track's module actually has open.
  // It comes first because the evidence query is scoped to it.
  const track = useTrack();
  const connections = useConnections();
  const setupState = useSetupState(track.benchmarkId);
  const resetSetup = useResetSetupState();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const requestedReplay = searchParams.get("replay");
  const replay =
    devTools && (requestedReplay === "creator" || requestedReplay === "member")
      ? requestedReplay
      : null;

  const loading = track.isPending || setupState.isPending || connections.isPending;

  // The dashboard nudge links to `#step-<id>`. The router doesn't scroll to a
  // hash on a client-side navigation, so the page does it once the rail exists.
  useEffect(() => {
    if (loading || !location.hash.startsWith("#step-")) return;
    const row = document.getElementById(location.hash.slice(1));
    if (!row) return;
    row.scrollIntoView({ block: "start" });
    row.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, [loading, location.hash]);

  // These reads decide both the commands and their verified state. Their
  // fallback values are not safe instructions for a student to copy.
  if (loading) {
    return <LoadingMark label="Loading your team" />;
  }

  // A failed evidence read and a student who has run nothing produce the same
  // empty verified set, so without this the page reports somebody's finished
  // setup as work they never did. The commands come from the team and the
  // track, which did load, so the rail stays on screen and stays copyable;
  // only the claim about what we have seen is withheld.
  const unreadable = {
    "setup-state": setupState.isError,
    devices: connections.isError,
  } as const;
  const evidenceFailed = setupState.isError || connections.isError;
  const retryEvidence = () => {
    if (setupState.isError) void setupState.refetch();
    if (connections.isError) void connections.refetch();
  };

  // Replay masks the evidence rather than the commands: a rehearsing owner
  // sees the rail a student sees on day zero.
  const lines = setupCommandsForTeam({
    repo: team.repo,
    benchmark: track.benchmark,
    benchmarkId: track.benchmarkId,
    verifiedSteps: replay ? [] : setupState.data?.verified,
    verifiedStepsForBenchmark: replay
      ? []
      : setupState.data?.verifiedByBenchmark[track.benchmarkId],
    checkedSteps: replay ? [] : setupState.data?.checked,
    checkedStepsForBenchmark: replay
      ? []
      : setupState.data?.checkedByBenchmark[track.benchmarkId],
    cliDeviceCount: replay ? 0 : (connections.data?.cliDevices.length ?? 0),
    portalOrigin: window.location.origin,
  });

  // The count and the rail read the same array, so the masthead can never
  // claim a number the steps do not show.
  const { done, verified, total } = setupCommandProgress(lines);
  const states = lines.map((line) => stepState(line, unreadable));
  // Signed for the track above, so switching tracks fetches a fresh set and a
  // command copied for one benchmark cannot tick another's box.
  const tokens = replay ? undefined : setupState.data?.tokens;
  const complete = !evidenceFailed && done === total;
  // A checked-off step is the student's word, so the completion panel claims
  // (and colours as) verified only what the portal itself observed.
  const observed = verified === total;
  const next = evidenceFailed ? undefined : nextSetupLine(lines);
  const benchmarkTitle = track.benchmark?.title ?? track.benchmarkId;
  const environment = benchmarkEnvironment(track.benchmarkId);

  // Mono is the data face and has no italic of its own worth reading, so a
  // command named inside an italic note stands upright.
  const code = (text: string) => (
    <code className="font-mono text-[0.88em] text-ink not-italic">{text}</code>
  );

  // What each command is for. A Record rather than a function, so a new
  // SetupCommandId fails to compile until someone writes its reason instead
  // of rendering a bare command under nothing. `note` is the why, set in the
  // margin; `after` is anything a student needs at the moment they run it.
  const said: Record<SetupCommandId, { note: ReactNode; after?: ReactNode }> = {
    clone: {
      note: (
        <>
          You all work in this one repository, and every hosted run starts from
          it rather than from somebody's laptop.
        </>
      ),
    },
    tool: {
      note: (
        <>
          The {code("cogworks")} commands further down come from this package.
          It's pinned to one commit, so everyone reading this page installs the
          same tool.
        </>
      ),
      after: (
        <p>
          If pip answers {code("externally-managed-environment")}, the course
          environment isn't active; activate it and run this again.
        </p>
      ),
    },
    benchmark: {
      note: (
        <>
          The {benchmarkTitle} scorer and its checks live in their own package,
          so this line changes when you switch tracks.
        </>
      ),
    },
    link: {
      note: (
        <>
          Linking lets {code("check")} and {code("sync")} report to your team.{" "}
          {code("check")} sends check names, package versions and your
          repository; {code("sync")} uploads one saved report you choose, with
          any weight file it used that isn't already in your commit. You can
          revoke the device from{" "}
          <Link to="/connections" className="u-link">
            Connections
          </Link>
          .
        </>
      ),
      after: <p>It prints a short code and opens this portal so you can approve it.</p>,
    },
    check: {
      note: (
        <>
          {code("check")} reads your repository and reports which of your own
          functions it wired up. It also confirms the steps above, so their
          boxes tick together.
        </>
      ),
      after: <p>If the box doesn't tick, the reason is in your terminal.</p>,
    },
  };

  return (
    <div className="page anim-rise">
      {devTools && (
        <DevRehearsal
          replay={replay}
          busy={resetSetup.isPending}
          onMode={(mode) => {
            if (mode) setSearchParams({ replay: mode }, { replace: true });
            else setSearchParams({}, { replace: true });
          }}
          onReset={() =>
            resetSetup.mutate(undefined, {
              onSuccess: () => {
                clearSetupProgress(team.id, login);
                window.location.assign("/setup?replay=creator");
              },
            })
          }
        />
      )}

      {arrival && <ArrivalNote arrival={arrival} team={team} login={login} />}

      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-baseline gap-x-2.5">
            <span>{team.name}</span>
            <a
              href={team.repo.url}
              target="_blank"
              rel="noreferrer"
              className="u-link font-mono text-[12.5px] font-normal text-ink-secondary"
            >
              {team.repo.fullName}
            </a>
          </span>
        }
        title="Set up your machine"
        lede={
          <>
            {total === 4 ? "Four" : "Five"} steps get a fresh terminal ready to
            run {benchmarkTitle} against your team's code. Keep this page open
            beside it, and the boxes tick themselves as your terminal reports
            back.
          </>
        }
        // Every command on this page names a benchmark, so the page has to
        // show which one and let a student change it. Without this the
        // default track silently decides what they're told to type.
        actions={
          <TrackSwitcher tracks={track.tracks} benchmark={track.benchmark} onSelect={track.select} />
        }
      />

      <div className="mt-8 flex max-w-[42rem] flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-4">
        {!evidenceFailed && <StepCells states={states} />}
        <p aria-live="polite" className="text-[14px] text-ink">
          {evidenceFailed ? (
            "Progress unavailable"
          ) : (
            <>
              <span className="font-semibold u-tnum">
                {done} of {total} done
              </span>
              {done > 0 && <span className="text-ink-secondary">{whoTicked(verified, done - verified)}</span>}
            </>
          )}
          {replay && <span className="text-detect-deep"> · replaying {replay}</span>}
        </p>
        {/* True while the evidence queries poll, which they do until every
            line is ticked: the page really is waiting on the terminal. */}
        {!complete && !evidenceFailed && !replay && (
          <p className="flex items-center gap-2 text-[13px] text-ink-faint sm:ml-auto">
            <span aria-hidden="true" className="anim-live size-1.5 rounded-full bg-verify" />
            Watching for your terminal
          </p>
        )}
        {complete && (
          <Link to="/dashboard" className="u-link inline-flex items-center gap-1 text-[14px] font-semibold sm:ml-auto">
            Go to Runs
            <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
          </Link>
        )}
      </div>

      {evidenceFailed && (
        <div className="mt-6 max-w-[42rem]">
          {/* Not an empty rail and not a blocked page: the commands below are
              still correct. What failed is the read of what we have observed,
              which is why no step can claim a tick. */}
          <QueryError error={setupState.error ?? connections.error} retry={retryEvidence} />
        </div>
      )}

      {/* A precondition rather than a step: the portal can't watch a shell, so
          it never ticks and never counts, and numbering it would put a sixth
          item on a page that counts five. */}
      {environment && (
        <section className="mt-10">
          <h2 className="u-label">Before you start</h2>
          <Annotated
            className="mt-1"
            note={
              <>
                Every command below runs inside the environment you built for the{" "}
                <a href={environment.prereqsUrl} target="_blank" rel="noreferrer" className="u-link">
                  {benchmarkTitle} prerequisites
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    size={12}
                    strokeWidth={1.8}
                    className="ml-0.5 inline-block align-[-0.05em]"
                    aria-hidden="true"
                  />
                </a>
                . The portal can't see your shell, so this one has no box.
              </>
            }
          >
            <p className="text-[14px] text-ink-secondary">
              Open a terminal and switch to the course environment.
            </p>
            <div className="mt-3">
              <Code lang="bash" code={`conda activate ${environment.condaEnv}`} />
            </div>
          </Annotated>
        </section>
      )}

      <div className={environment ? "mt-10 border-t border-rule-soft pt-10" : "mt-10"}>
        <StepRail>
          {lines.map((line, index) => {
            const state = states[index]!;
            return (
              <Step
                key={`${track.benchmarkId}:${line.id}`}
                id={`step-${line.id}`}
                index={String(index + 1)}
                state={state}
                title={setupStepTitle(line.id, benchmarkTitle)}
                note={said[line.id].note}
                current={line.id === next?.id}
                // Read once, when the row mounts: a step ticked before the page
                // opened starts folded, and one that ticks while the student
                // watches stays open, so a check landing never pulls the page
                // up under the line they're reading.
                folded={state === "verified" || state === "checked"}
                last={index === lines.length - 1}
              >
                <Code lang="bash" code={line.command} wrap />
                {line.dataCommand && (
                  <>
                    <p>
                      pip doesn't install the course files this scorer reads, so
                      fetch them once. It's nearly 1 GB and can take a while;
                      copies {code("cogworks-data")} already downloaded are reused.
                    </p>
                    <Code lang="bash" code={line.dataCommand} wrap />
                  </>
                )}
                {said[line.id].after}
                <TerminalCheckoff step={line.step} state={state} tokens={tokens} />
              </Step>
            );
          })}
        </StepRail>
      </div>

      {complete ? (
        <Panel
          label="Setup complete"
          tone={observed ? "good" : "default"}
          className="anim-rise mt-12 max-w-[42rem]"
        >
          <p className="text-[14.5px] leading-[1.6] text-ink">
            {observed
              ? "Everything the portal can verify checks out. Your terminal found the repository and called your code."
              : "Every step is ticked; the ones marked checked off are your own report rather than something the portal saw."}
          </p>
          <p className="mt-3 text-[14px] leading-[1.6] text-ink-secondary">
            Whether the code is any good is what runs are for. Local runs are
            unlimited and score the same way, so start there:
          </p>
          <div className="mt-3">
            <Code lang="bash" code={`cogworks run --benchmark ${track.benchmarkId}`} wrap />
          </div>
          <Link to="/dashboard" className={buttonClass("primary", "mt-5")}>
            Go to Runs
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.8} aria-hidden="true" />
          </Link>
        </Panel>
      ) : (
        <p className="mt-12 max-w-[42rem] border-t border-rule-soft pt-5 text-[14px] leading-[1.6] text-ink-secondary">
          No rush; the guide keeps your place. Hosted practice runs build from
          your pushed commit and don't need any of this, so you can{" "}
          <Link to="/dashboard" className="u-link">
            start one from Runs
          </Link>{" "}
          whenever you like.
        </p>
      )}
    </div>
  );
}

/** Who ticked the boxes counted as done, so the count never blurs what the
 *  portal saw with what the student told it. */
function whoTicked(seen: number, checked: number): string {
  const both = (count: number) => (count === 1 ? "" : count === 2 ? "both " : "all ");
  if (checked === 0) return `, ${both(seen)}seen by the portal`;
  if (seen === 0) return `, ${both(checked)}checked off by you`;
  return `: ${seen} seen by the portal, ${checked} checked off by you`;
}

/* ── Arrival ──────────────────────────────────────────────────────────── */

/**
 * The one time this page says something about the team itself: right after
 * the student made it or joined it. It names who else is on it, because that
 * is the first thing a student wonders, and points at step 1. It sits above
 * the steps rather than in front of them, and it is gone on the next visit.
 */
function ArrivalNote({
  arrival,
  team,
  login,
}: {
  arrival: Arrival;
  team: TeamDetail;
  login: string;
}) {
  const others = team.members.filter((member) => member.login !== login);
  return (
    <div
      role="status"
      className="anim-rise mb-10 flex max-w-[42rem] gap-3.5 rounded-r-surface border-l-2 border-verify bg-verify-wash px-5 py-4"
    >
      <HugeiconsIcon
        icon={Tick02Icon}
        size={18}
        strokeWidth={2}
        aria-hidden="true"
        className="mt-1 shrink-0 text-verify"
      />
      <div>
        <p className="font-serif text-[18px] leading-snug font-semibold text-ink">
          {arrival === "created" ? `You've created ${team.name}` : `You're on ${team.name}`}
        </p>
        <p className="mt-1 text-[14px] leading-[1.6] text-ink-secondary">
          {arrival === "created" && (
            <>
              You're its first member. Classmates join by picking it from the
              team list once they've entered the cohort code, or you can add
              them from the{" "}
              <Link to="/team" className="u-link">
                Team page
              </Link>
              .{" "}
            </>
          )}
          {arrival === "joined" && others.length > 0 && (
            <>You're working with {namesOf(others)}. </>
          )}
          Start with step 1 below, which clones the team's repository.
        </p>
      </div>
    </div>
  );
}

function namesOf(members: TeamMember[]): ReactNode {
  return members.map((member, index) => (
    <Fragment key={member.login}>
      {index === 0 ? "" : index === members.length - 1 ? " and " : ", "}
      <span className="font-mono text-[0.92em] text-ink">@{member.login}</span>
    </Fragment>
  ));
}

/* ── Terminal check-off ───────────────────────────────────────────────── */

/**
 * One line, pasted in the same terminal, and the box ticks itself.
 *
 * The three steps this appears under are the ones nothing reports until
 * `check` runs at the end, so without it a student clones and installs against
 * silent boxes. It marks this step and sends nothing else, and the box it
 * ticks says "checked off by you" rather than "seen by the portal", because a
 * command reaching us is the student telling us they did it and not CogPortal
 * watching them do it.
 *
 * It is folded away because it is secondary and noisy: the step's own command
 * is the thing to run, and this is for a student who wants the box now rather
 * than at `check`. A native `details`, so the line stays in the document (find
 * in page opens it) and needs no focus handling of its own.
 *
 * A python one-liner rather than curl: PowerShell aliases curl to something
 * with different arguments, and the course environment guarantees python
 * everywhere. It posts rather than gets, so a link prefetcher or a scanner
 * that follows the address cannot tick anybody's box.
 *
 * `http.client` rather than `urlopen`, which raises on a 4xx: a stale command
 * would print a traceback ending in "HTTP Error 400" instead of the sentence
 * telling the student to copy a fresh one. This prints whatever the server
 * said, which is the point of running it.
 */
function TerminalCheckoff({
  step,
  state,
  tokens,
}: {
  step: SetupStep | null;
  state: StepState;
  tokens: Record<string, string> | undefined;
}) {
  if (!step || !isSelfCheckableStep(step) || state !== "pending") return null;
  const token = tokens?.[step];
  if (!token) return null;
  const connection = window.location.protocol === "https:" ? "HTTPSConnection" : "HTTPConnection";
  const path = `/api/v1/setup/check-off?t=${token}`;
  return (
    <details className="group">
      <summary className="u-pressable inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-control text-[13.5px] font-semibold text-ink-secondary transition-colors duration-150 hover:text-ink [&::-webkit-details-marker]:hidden">
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        Tick this box from your terminal
      </summary>
      <div className="mt-1 mb-1 border-l border-rule pl-4">
        <p className="text-[13.5px] leading-[1.6] text-ink-secondary">
          Once this step has worked, paste this into the same terminal.
          It records that you did this one step and sends nothing else;{" "}
          <code className="font-mono text-[0.92em] text-ink">check</code> confirms
          it for itself at the end.
        </p>
        {/* Keep the signed token plain and on one scrollable line. */}
        <CopyBlock
          className="mt-2.5"
          lang="text"
          text={
            `python -c "import http.client as h; c = h.${connection}('${window.location.host}'); ` +
            `c.request('POST', '${path}'); print(c.getresponse().read().decode())"`
          }
        />
      </div>
    </details>
  );
}

function DevRehearsal({
  replay,
  busy,
  onMode,
  onReset,
}: {
  replay: "creator" | "member" | null;
  busy: boolean;
  onMode: (mode: "creator" | "member" | null) => void;
  onReset: () => void;
}) {
  return (
    <div className="mb-8 flex max-w-[42rem] flex-wrap items-center gap-2 rounded-surface border border-detect/25 bg-detect-wash px-3 py-2.5">
      <span className="u-label mr-2 text-detect-deep">Dev rehearsal</span>
      {([null, "creator", "member"] as const).map((mode) => (
        <Button
          key={mode ?? "live"}
          type="button"
          variant={replay === mode ? "primary" : "quiet"}
          className="!min-h-8 px-3 !text-[12.5px]"
          onClick={() => onMode(mode)}
        >
          {mode ?? "Live state"}
        </Button>
      ))}
      <span className="ml-auto">
        <ConfirmButton
          label="Reset guide"
          confirmLabel="Confirm, this clears your ticks"
          onConfirm={onReset}
          busy={busy}
          className="!min-h-8 px-3 !text-[12.5px]"
        />
      </span>
    </div>
  );
}
