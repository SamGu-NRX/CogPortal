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
  const connections = useConnections();
  const setupState = useSetupState();
  const resetSetup = useResetSetupState();
  // The commands below have to name a real benchmark, and the entry points a
  // student must register are whatever this track's module actually has open.
  const track = useTrack();
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

  // Replay masks the evidence rather than the commands: a rehearsing owner
  // sees the sheet a student sees on day zero.
  const lines = setupCommandsForTeam({
    repo: team.repo,
    benchmark: track.benchmark,
    benchmarkId: track.benchmarkId,
    verifiedSteps: replay ? [] : setupState.data?.verified,
    cliDeviceCount: replay ? 0 : (connections.data?.cliDevices.length ?? 0),
    portalOrigin: window.location.origin,
  });

  // The count and the gutter read the same array, so the masthead can never
  // claim a number the sheet does not show.
  const { verified, total } = setupCommandProgress(lines);
  const complete = verified === total;
  const benchmarkTitle = track.benchmark?.title ?? track.benchmarkId;

  /**
   * What each command is for, keyed by id. A Record rather than a function, so
   * a new SetupCommandId fails to compile until someone writes its note
   * instead of rendering a bare command under an explained list.
   */
  const notes: Record<SetupCommandId, CommandNote> = {
    clone: {
      title: "Clone your team's repository",
      why: "Every hosted attempt runs from this repository rather than from somebody's laptop, so a score is always about this copy. Work inside it from here on.",
      help: "A folder with a similar name is not enough. The commands below compare this clone's GitHub remote against your team.",
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
          course environment is not active. Activate it and run the line again.
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
          .
        </>
      ),
      help: "Linking tells us the repository you are standing in, which fills the first box. Nothing else reports on its own: scoring stays on your machine unless you ask for it.",
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
      help: "It reports only when it passes. If boxes stay grey, the answer is in your terminal: fix what it names there and run the same line again.",
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
            Setup · {verified} of {total} verified
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
        {total} commands, in this order. Nothing here ticks as you type. The last
        one is what reports back, and it fills several boxes at once, so grey
        rows above it are normal until then.
      </p>

      <div className="mt-6">
        <CommandSheet lines={lines} label="Setup commands, in run order" notes={notes} />
      </div>

      {complete ? (
        <Panel label="SETUP COMPLETE" tone="good" className="mt-6">
          <p className="max-w-[58ch] text-[14px] leading-[1.6] text-ink">
            Every command above has reported back. Nothing here is a grade, and
            none of it says the code is good yet: what it says is that the tool
            can find your work and call it. A local run is the next thing, and it
            costs nothing.
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
