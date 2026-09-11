import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useSearchParams } from "react-router";
import type { TeamDetail, TeamMember } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { Code } from "@/components/Code";
import { CommandSheet, type CommandNote } from "@/components/CommandSheet";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
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
  setupCommandProgress,
  setupCommandsForTeam,
  type SetupCommandId,
} from "@/lib/setup-progress";

export function SetupPage() {
  const team = useTeam();
  const { data: session } = useSession();

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
      devTools={session.auth.onboardingDevToolsEnabled && session.user.isOwner}
    />
  );
}

function SetupGuide({
  team,
  login,
  devTools,
}: {
  team: TeamDetail;
  login: string;
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
  const requestedReplay = searchParams.get("replay");
  const replay =
    devTools && (requestedReplay === "creator" || requestedReplay === "member")
      ? requestedReplay
      : null;

  // These reads decide both the commands and their verified state. Their
  // fallback values are not safe instructions for a student to copy.
  if (track.isPending || setupState.isPending || connections.isPending) {
    return <LoadingMark label="Loading your team" />;
  }

  // A failed evidence read and a student who has run nothing produce the same
  // empty verified set, so without this the page reports somebody's finished
  // setup as work they never did. The commands come from the team and the
  // track, which did load, so the sheet stays on screen and stays copyable;
  // only the claim about what we have seen is withheld.
  const evidenceFailed = setupState.isError || connections.isError;
  const retryEvidence = () => {
    if (setupState.isError) void setupState.refetch();
    if (connections.isError) void connections.refetch();
  };

  // Replay masks the evidence rather than the commands: a rehearsing owner
  // sees the sheet a student sees on day zero.
  const lines = setupCommandsForTeam({
    repo: team.repo,
    benchmark: track.benchmark,
    benchmarkId: track.benchmarkId,
    verifiedSteps: replay ? [] : setupState.data?.verified,
    verifiedStepsForBenchmark: replay
      ? []
      : setupState.data?.verifiedByBenchmark[track.benchmarkId],
    cliDeviceCount: replay ? 0 : (connections.data?.cliDevices.length ?? 0),
    portalOrigin: window.location.origin,
  });

  // The count and the gutter read the same array, so the masthead can never
  // claim a number the sheet does not show.
  const { verified, total } = setupCommandProgress(lines);
  // Every open box belongs to this track and at least one is ticked: the
  // switched-track state, where the count reads as lost work rather than as
  // two commands nobody has run for this benchmark yet.
  const onlyTrackStepsLeft =
    verified > 0 &&
    lines.some((line) => !line.verified) &&
    lines.every((line) => line.verified || line.benchmarkScoped);
  const complete = !evidenceFailed && verified === total;
  const benchmarkTitle = track.benchmark?.title ?? track.benchmarkId;
  const environment = benchmarkEnvironment(track.benchmarkId);

  /**
   * What each command is for, keyed by id. A Record rather than a function, so
   * a new SetupCommandId fails to compile until someone writes its note
   * instead of rendering a bare command under an explained list.
   */
  const notes: Record<SetupCommandId, CommandNote> = {
    clone: {
      title: "Clone your team's repository",
      why: "Every hosted attempt runs from this repository rather than from somebody's laptop, so a score is always about this copy. Work inside it from here on.",
      help: "A folder with a similar name is not enough. The commands below compare this clone's GitHub remote with your team's repository.",
    },
    tool: {
      title: "Install the CogWorks tool",
      why: (
        <>
          <code className="font-mono text-[12.5px]">cogworks</code> is what reads
          your repository and works out which of your own functions the benchmark
          should call. It is pinned to one commit, so everyone reading this page
          installs the same tool.
        </>
      ),
      help: (
        <>
          If your terminal answers{" "}
          <code className="font-mono">cogworks: command not found</code>, the
          install landed somewhere this shell isn't looking. An inactive course
          environment is the usual reason, so check that first and run the line
          again.
        </>
      ),
    },
    benchmark: {
      title: `Install the ${benchmarkTitle} benchmark`,
      why: `The scorer for ${benchmarkTitle}, its data and its checks live in their own package. Changing the track at the top of this page changes this line.`,
      help: "It brings the few packages the scorer itself needs. The rest of the course stack, the one your own code imports, comes from your week's environment.",
    },
    link: {
      title: "Link this machine to CogPortal",
      why: (
        <>
          This opens CogPortal to approve the connection and then hands your
          terminal back. It is what lets a command report to your team, and you
          can revoke it from{" "}
          <Link
            to="/connections"
            className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
          >
            Connections
          </Link>
          . Nothing reports unless you ask it to; a local score stays on your
          machine until you send it.
        </>
      ),
      help: (
        <>
          It prints the address and the code before it opens anything, so if no
          browser appears you can go there yourself, or add{" "}
          <code className="font-mono">--no-browser</code> to skip the attempt. If
          the code expires before you approve it, run the same line again for a
          fresh one. When it returns, the clone box above should tick: linking
          reports the repository you are standing in.
        </>
      ),
    },
    check: {
      title: "Check it, and tell this page",
      why: (
        <>
          <code className="font-mono text-[12.5px]">check</code> reads your
          repository and reports what it found: which of your functions it wired
          up, and which packages this machine is missing.{" "}
          <code className="font-mono text-[12.5px]">--update-setup</code> is the
          part that sends the result here.
        </>
      ),
      help: "It reports only when it passes. If boxes stay empty, the answer is in your terminal: fix what it names there and run the same line again.",
    },
  };

  return (
    <div className="anim-rise mx-auto w-full max-w-2xl py-12 sm:py-14">
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

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="u-kicker" aria-live="polite">
            Setup ·{" "}
            {evidenceFailed ? "progress unavailable" : `${verified} of ${total} verified`}
            {replay ? ` · replaying ${replay}` : ""}
          </p>
          <h1 className="mt-1 truncate text-3xl">{team.name}</h1>
        </div>
        {/* Every command on this page names a benchmark, so the page has to
            show which one and let a student change it. Without this the
            default track silently decides what they're told to type. */}
        <TrackSwitcher
          tracks={track.tracks}
          benchmark={track.benchmark}
          onSelect={track.select}
        />
      </div>

      <a
        href={team.repo.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-block font-mono text-[12px] text-ink-secondary underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink"
      >
        {team.repo.fullName}
      </a>

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-rule-soft pt-4">
        <MemberStrip members={team.members} />
        <span className="font-mono text-[11.5px] text-ink-secondary">
          {team.members.length} {team.members.length === 1 ? "member" : "members"}
        </span>
        <Link
          to="/team"
          className="u-pressable ml-auto inline-flex min-h-9 items-center font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink"
        >
          Add
        </Link>
      </div>

      {/* The one thing a student cannot work out by looking. Nothing here
          ticks as you type: `check` reports clone, environment, project and
          wiring in a single call (cli.py), so four boxes fill on the last
          command and grey rows above it are expected until then. */}
      {/* The count comes from the sheet: a track with no packaged benchmark
          has four commands, not five. */}
      <p className="mt-7 max-w-[58ch] text-[14px] leading-[1.6] text-ink-secondary">
        {total} commands, in this order.{" "}
        {evidenceFailed
          ? "The commands are right and you can run them now."
          : onlyTrackStepsLeft
            ? `The ticked ones are about this machine and carry over between tracks. The empty ones are about ${benchmarkTitle} and haven't reported for it yet.`
            : "Nothing ticks as you type; boxes fill when a command reports back, and most of them fill on the last one, so empty boxes above it are normal until then."}
      </p>

      {/* Everything below the clone installs into whichever environment is
          active, so this belongs above the first pip line rather than in the
          help under it. The name is not ours: it comes from the same per-week
          table as the benchmark distribution, transcribed from CogWeb in
          docs/capstones/environment.md. Inline code rather than a copy block,
          because every command in a box on this page has a gutter cell and
          this one has no evidence behind it. */}
      <p className="mt-4 max-w-[58ch] border-l-2 border-rule pl-4 text-[13.5px] leading-[1.6] text-ink-secondary">
        Activate your course environment before the installs below, so the tool
        lands beside the packages your own code already uses.{" "}
        {environment ? (
          <>
            CogWeb calls {benchmarkTitle}'s{" "}
            <code className="font-mono text-[12.5px] text-ink">
              {environment.condaEnv}
            </code>
            , and{" "}
            <a
              href={environment.prereqsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
            >
              its prerequisites ↗
            </a>{" "}
            list what belongs in it. If you set yours up under another name, or
            without conda, activate that one instead.
          </>
        ) : (
          <>
            Use the one your week's prerequisites describe. Without it the tool
            installs somewhere your terminal will not find it.
          </>
        )}
      </p>

      {evidenceFailed && (
        <div className="mt-6">
          {/* Not an empty sheet and not a blocked page: the commands below are
              still correct. What failed is the read of what we have observed,
              which is why the gutter shows dashes instead of empty boxes. */}
          {/* No children: the mapping's own way out is already the right one
              here. A plain fault offers retry and no link, and the cases that
              do carry a link (session ended, cohort or team required) send the
              student exactly where they need to go. */}
          <QueryError
            error={setupState.error ?? connections.error}
            retry={retryEvidence}
          />
        </div>
      )}

      <div className="mt-6">
        <CommandSheet
          lines={lines}
          label="Setup commands, in run order"
          notes={notes}
          unreadable={{
            "setup-state": setupState.isError,
            devices: connections.isError,
          }}
        />
      </div>

      {complete ? (
        <Panel label="SETUP COMPLETE" tone="good" className="mt-6">
          <p className="max-w-[58ch] text-[14px] leading-[1.6] text-ink">
            Every command above has reported back from a machine you linked,
            so the tool found your functions and called them. Whether the code
            is any good is what runs are for, and a local run is the next
            thing; there's no limit on those.
          </p>
          <div className="mt-4">
            <Code lang="bash" code={`cogworks run --benchmark ${track.benchmarkId}`} />
          </div>
          <Link
            to="/dashboard"
            className="u-pressable mt-4 inline-flex h-11 items-center gap-2 bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
          >
            Open dashboard
            <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
          </Link>
        </Panel>
      ) : (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-rule-soft pt-5">
          <p className="text-[12.5px] text-ink-faint">
            No rush. This page keeps your place.
          </p>
          <Link
            to="/dashboard"
            className="u-pressable inline-flex min-h-9 items-center gap-1.5 font-mono text-[11.5px] tracking-[0.07em] text-ink-secondary uppercase hover:text-ink"
          >
            Open dashboard
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}

function MemberStrip({ members }: { members: TeamMember[] }) {
  const shown = members.slice(0, 6);
  const extra = members.length - shown.length;
  return (
    <span className="flex min-w-0 items-center">
      <span className="flex -space-x-1.5">
        {shown.map((member) =>
          member.avatarUrl ? (
            <img
              key={member.login}
              src={member.avatarUrl}
              alt=""
              title={`@${member.login}`}
              className="size-6 rounded-[2px] border border-paper"
            />
          ) : (
            <span
              key={member.login}
              aria-hidden="true"
              title={`@${member.login}`}
              className="flex size-6 items-center justify-center rounded-[2px] border border-paper bg-paper-sunken font-mono text-[10px] text-ink-secondary uppercase"
            >
              {member.login[0]}
            </span>
          ),
        )}
      </span>
      {extra > 0 && <span className="ml-2 font-mono text-[10.5px] text-ink-faint">+{extra}</span>}
      <span className="sr-only">{members.map((member) => `@${member.login}`).join(", ")}</span>
    </span>
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
    <div className="mb-8 flex flex-wrap items-center gap-2 border border-detect/25 bg-detect-wash px-3 py-2.5">
      <span className="mr-2 font-mono text-[10px] tracking-[0.09em] text-detect-deep uppercase">Dev rehearsal</span>
      {([null, "creator", "member"] as const).map((mode) => (
        <Button
          key={mode ?? "live"}
          type="button"
          variant={replay === mode ? "primary" : "quiet"}
          className="!min-h-8 px-3 !text-[11px]"
          onClick={() => onMode(mode)}
        >
          {mode ?? "Live state"}
        </Button>
      ))}
      <span className="ml-auto">
        <ConfirmButton
          label="Reset guide"
          confirmLabel="Confirm reset"
          onConfirm={onReset}
          busy={busy}
          className="!min-h-8 px-3 !text-[11px]"
        />
      </span>
    </div>
  );
}
