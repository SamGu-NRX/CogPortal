import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useSearchParams } from "react-router";
import type { TeamDetail, TeamMember } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { CommandSheet } from "@/components/CommandSheet";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingMark, QueryError } from "@/components/Feedback";
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

  return (
    <div className="anim-rise mx-auto w-full max-w-xl py-12 sm:py-14">
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

      <div className="mt-6">
        <CommandSheet lines={lines} label="Setup commands, in run order" />
      </div>

      {complete ? (
        <Link
          to="/dashboard"
          className="u-pressable mt-7 inline-flex h-11 items-center gap-2 bg-ink px-6 text-[13.5px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
        >
          Open dashboard
          <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
        </Link>
      ) : (
        <Link
          to="/dashboard"
          className="u-pressable mt-7 inline-flex min-h-9 items-center gap-1.5 font-mono text-[11.5px] tracking-[0.07em] text-ink-secondary uppercase hover:text-ink"
        >
          Open dashboard
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
        </Link>
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
