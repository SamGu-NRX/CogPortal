import { ArrowRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import {
  isSelfCheckableStep,
  type SetupStep,
  type TeamDetail,
  type TeamMember,
} from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { Code } from "@/components/Code";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyBlock } from "@/components/CopyBlock";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { Step, StepRail } from "@/components/StepRail";
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
  stepState,
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

/**
 * The setup guide: one page from "you have a team" to "the tool called your
 * code", as a numbered rail a student works down.
 *
 * Every tick is something CogPortal observed. A command reports through the
 * device you linked, so a box fills because evidence arrived, never because
 * the page was told to believe something.
 */
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
  const { done, total } = setupCommandProgress(lines);
  // Signed for the track above, so switching tracks fetches a fresh set and a
  // command copied for one benchmark cannot tick another's box.
  const tokens = replay ? undefined : setupState.data?.tokens;
  const complete = !evidenceFailed && done === total;
  const benchmarkTitle = track.benchmark?.title ?? track.benchmarkId;
  const environment = benchmarkEnvironment(track.benchmarkId);

  // What each command is for. A Record rather than a function, so a new
  // SetupCommandId fails to compile until someone writes its line instead of
  // rendering a bare command under nothing.
  const said: Record<SetupCommandId, { title: string; body: ReactNode }> = {
    clone: {
      title: "Get the code",
      body: (
        <p>
          Clone the team's repository. You all work in the same one, and every
          hosted attempt runs from it rather than from somebody's laptop.
        </p>
      ),
    },
    tool: {
      title: "Set up your environment",
      body: (
        <p>
          From your repository's root, with{" "}
          {environment ? (
            <>
              <code className="font-mono text-[12px]">
                conda activate {environment.condaEnv}
              </code>{" "}
              done, the environment you built for the{" "}
              <a
                href={environment.prereqsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
              >
                {benchmarkTitle} prerequisites
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={1.8} aria-hidden="true" />
              </a>
              :
            </>
          ) : (
            <>your week's course environment active:</>
          )}
        </p>
      ),
    },
    benchmark: {
      title: `Install the ${benchmarkTitle} benchmark`,
      body: (
        <p>
          The scorer for {benchmarkTitle}, its data and its checks live in their
          own package. Changing the track above changes this line.
        </p>
      ),
    },
    link: {
      title: "Link this device",
      body: (
        <p>
          Lets a command report back to your team. What reaches CogPortal is
          check names, package versions and your repository, and you can revoke
          this device from{" "}
          <Link
            to="/connections"
            className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
          >
            Connections
          </Link>
          .
        </p>
      ),
    },
    check: {
      title: "Prove the wiring",
      body: (
        <p>
          <code className="font-mono text-[12px]">check</code> reads your
          repository and says which of your own functions it wired up, and
          reports what it found. If it doesn't tick, the reason is in your
          terminal.
        </p>
      ),
    },
  };

  return (
    <div className="anim-rise mx-auto w-full max-w-lg py-14">
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
            {evidenceFailed ? "progress unavailable" : `${done} of ${total} done`}
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

      {evidenceFailed && (
        <div className="mt-6">
          {/* Not an empty rail and not a blocked page: the commands below are
              still correct. What failed is the read of what we have observed,
              which is why no step can claim a tick. */}
          <QueryError error={setupState.error ?? connections.error} retry={retryEvidence} />
        </div>
      )}

      <div className="mt-9">
        <StepRail>
          {lines.map((line, index) => {
            const state = stepState(line, unreadable);
            return (
              <Step
                key={line.id}
                index={String(index + 1).padStart(2, "0")}
                state={state}
                title={said[line.id].title}
                last={index === lines.length - 1}
              >
                {said[line.id].body}
                <div className="mt-2.5">
                  <Code lang="bash" code={line.command} wrap />
                </div>
                <TerminalCheckoff step={line.step} state={state} tokens={tokens} />
              </Step>
            );
          })}
        </StepRail>
      </div>

      {complete ? (
        <Panel label="SETUP COMPLETE" tone="good" className="mt-8">
          <p className="text-[14px] leading-[1.6] text-ink">
            Everything the portal can verify checks out. Whether the code is
            any good is what runs are for, and there's no limit on local ones.
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
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-rule-soft pt-5">
          <p className="text-[12.5px] text-ink-faint">No rush. This page keeps your place.</p>
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

/* ── Terminal check-off ───────────────────────────────────────────────── */

/**
 * One line, pasted in the same terminal, and the box ticks itself.
 *
 * The three steps this appears under are the ones nothing reports until
 * `check` runs at the end, so without it a student clones and installs against
 * silent boxes. It marks this step and sends nothing else, and the box it
 * ticks says "done here" rather than "verified", because a command reaching us
 * is the student telling us they did it and not CogPortal watching them do it.
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
  state: "verified" | "checked" | "pending" | "unknown";
  tokens: Record<string, string> | undefined;
}) {
  if (!step || !isSelfCheckableStep(step) || state !== "pending") return null;
  const token = tokens?.[step];
  if (!token) return null;
  const connection = window.location.protocol === "https:" ? "HTTPSConnection" : "HTTPConnection";
  const path = `/api/v1/setup/check-off?t=${token}`;
  return (
    <div className="mt-2.5">
      <p className="text-[12px] text-ink-faint">
        Done here? Run this in the same terminal and the box ticks itself.
      </p>
      {/* One line that scrolls, unlike the install above it. The install ends
          in the commit it pins, which a student may want to read; this ends in
          a signed token nobody reads. Wrapped, it stood 205px tall and three
          of them buried the guide on first load. */}
      <CopyBlock
        className="mt-1.5"
        text={
          `python -c "import http.client as h; c = h.${connection}('${window.location.host}'); ` +
          `c.request('POST', '${path}'); print(c.getresponse().read().decode())"`
        }
      />
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
