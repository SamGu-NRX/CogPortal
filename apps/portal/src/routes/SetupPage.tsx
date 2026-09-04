import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { SetupStep, TeamDetail } from "@cogworks/contracts/schema";
import { Button } from "@/components/Button";
import { Code } from "@/components/Code";
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
  setupSteps,
  useSetupChecks,
  type SetupEntry,
} from "@/lib/setup-progress";

export function SetupPage() {
  const team = useTeam();
  const { data: session } = useSession();
  const location = useLocation();
  const entryState = (location.state as { entry?: SetupEntry } | null)?.entry;

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
      entry={entryState ?? (team.data.isAdmin ? "created" : "joined")}
      devTools={session.auth.onboardingDevToolsEnabled && session.user.isOwner}
    />
  );
}

function SetupGuide({
  team,
  login,
  entry,
  devTools,
}: {
  team: TeamDetail;
  login: string;
  entry: SetupEntry;
  devTools: boolean;
}) {
  const connections = useConnections();
  const setupState = useSetupState();
  const resetSetup = useResetSetupState();
  // The commands below have to name a real benchmark, and the entry points a
  // student must register are whatever this track's module actually has open.
  const track = useTrack();
  const benchmarkId = track.benchmarkId;
  const selectedModule = track.benchmark?.module;
  const moduleEntryPoints = selectedModule
    ? track.tracks
        .filter((benchmark) => benchmark.module === selectedModule)
        .map((benchmark) => benchmark.entryPointName)
    : [];
  const [searchParams, setSearchParams] = useSearchParams();
  const [checks, toggleCheck] = useSetupChecks(team.id, login);
  const [replayChecks, setReplayChecks] = useState<ReadonlySet<string>>(() => new Set());
  const requestedReplay = searchParams.get("replay");
  const replay =
    devTools && (requestedReplay === "creator" || requestedReplay === "member")
      ? requestedReplay
      : null;
  const visibleEntry: SetupEntry = replay === "creator" ? "created" : replay === "member" ? "joined" : entry;
  const visibleChecks = replay ? replayChecks : checks;
  const toggleVisibleCheck = (key: string) => {
    if (!replay) {
      toggleCheck(key);
      return;
    }
    setReplayChecks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const terminal = replay ? [] : (setupState.data?.verified ?? []);
  const terminalSet = new Set<SetupStep>(terminal);
  const teammates = replay ? false : team.members.length >= 2;
  const deviceLinked = replay ? false : (connections.data?.cliDevices.length ?? 0) > 0;
  const created = visibleEntry === "created";
  const teamFormationDone = created
    ? teammates || visibleChecks.has("teammates")
    : true;

  const { done, total } = setupSteps(visibleEntry, visibleChecks, {
    teammates,
    terminal,
  });
  const complete = done === total;
  const portalOrigin = window.location.origin;
  const machineState = (step: SetupStep) =>
    terminalSet.has(step) ? ("verified" as const) : ("pending" as const);

  // Device linking supports the wiring check but is not a counted milestone.
  const progress = [
    { label: "Team", done: true },
    { label: "People", done: teamFormationDone },
    { label: "Clone", done: terminalSet.has("clone") },
    { label: "Tool", done: terminalSet.has("environment") },
    { label: "Project", done: terminalSet.has("project") },
    { label: "Link", done: deviceLinked, unnumbered: true },
    { label: "Check", done: terminalSet.has("wiring") },
  ];

  let step = 0;
  const number = () => String(++step).padStart(2, "0");

  return (
    <div className="anim-rise mx-auto w-full max-w-4xl py-12 sm:py-14">
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

      <div className="grid items-start gap-10 lg:grid-cols-[170px_minmax(0,1fr)]">
        <ProgressRail progress={progress} />

        <div className="min-w-0 max-w-xl">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div className="min-w-0">
              <p className="u-kicker" aria-live="polite">
                Getting set up · {done} of {total}
                {replay ? ` · replaying ${replay}` : ""}
              </p>
              <h1 className="mt-1 text-3xl">
                {created ? "Your team has a home." : `You're on ${team.name}.`}
              </h1>
            </div>
            {/* Every command on this page names a benchmark, so the page has
                to show which one and let a student change it. Without this the
                default track silently decides what they're told to type. */}
            <TrackSwitcher
              tracks={track.tracks}
              benchmark={track.benchmark}
              onSelect={track.select}
            />
          </div>
          <p className="mt-2 text-[14px] text-ink-secondary">
            Work top to bottom in your terminal. Steps turn green on their own
            when the check in the last step runs, and it colors everything it
            can verify at once. Grey steps after you have done them are normal
            until then.
          </p>

          <ol className="relative mt-9">
            <li
              aria-hidden="true"
              className="absolute top-4 bottom-4 left-[13px] w-px bg-rule-soft"
            />

            <Step index={number()} state="verified" title="The team project" chip="portal verified">
              <p>
                <a
                  href={team.repo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[12px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                >
                  {team.repo.fullName}
                </a>{" "}
                is the shared source of truth. Hosted attempts always run from
                this repository, never from an uncommitted laptop folder.
              </p>
            </Step>

            <Step
              index={number()}
              state={teamFormationDone ? "verified" : "pending"}
              title={created ? "Bring your teammates" : "Know your team"}
              chip={teamFormationDone ? (created && !teammates ? "self checked" : "portal verified") : undefined}
              selfCheck={
                created && !teammates
                  ? {
                      checked: visibleChecks.has("teammates"),
                      onToggle: () => toggleVisibleCheck("teammates"),
                      label: "I'm working solo for now",
                    }
                  : undefined
              }
            >
              {created ? (
                <p>
                  Add collaborators in GitHub first, then add them from{" "}
                  <Link to="/team" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
                    Team settings
                  </Link>
                  . For group work, keep at least two organization owners so one
                  locked account cannot strand the team.
                </p>
              ) : (
                <p>
                  Your teammates share this repository and its attempts. Ask the
                  team creator for GitHub write access before you clone.
                </p>
              )}
            </Step>

            <Step index={number()} state={machineState("clone")} title="Clone the starter" chip={terminalSet.has("clone") ? "CLI checked" : undefined}>
              <p>Clone the exact repository CogPortal verified, then stay inside its worktree.</p>
              <Code lang="bash" code={`git clone ${team.repo.url}.git\ncd ${team.repo.name}`} />
              <p className="text-[12px] text-ink-faint">
                The link/check commands below compare this GitHub remote with
                your team. A similarly named folder is not enough.
              </p>
            </Step>

            <Step index={number()} state={machineState("environment")} title="Install the CogWorks tool" chip={terminalSet.has("environment") ? "CLI checked" : undefined}>
              <p>
                Activate the course environment your instructor provided, then
                install the lightweight CLI from the TestPyPI pilot channel.
              </p>
              {/*
                Deliberately unpinned, where almost everything else here is
                pinned. This tool reads your repository and tells you what it
                found, so an old copy does not give a stale answer, it gives a
                wrong one: 0.1.0 printed nine lines of True and False and named
                no next step. A student holding that version would be reading a
                report the platform stopped producing. `--upgrade` costs one
                network check and always gets the version that matches what the
                graded run does.
              */}
              <Code
                lang="bash"
                code="python -m pip install --upgrade --index-url https://test.pypi.org/simple/ --no-deps cogworks-benchmark"
              />
              <p className="text-[12px] text-ink-faint">
                The package is named <code className="font-mono">cogworks-benchmark</code>;
                the command it installs is <code className="font-mono">cogworks</code>.
                Those names intentionally differ.
              </p>
              {/* The most common terminal failure in a mixed conda/Windows
                  cohort, and it happens before the CLI exists, so the CLI's
                  own error messages never get to help. */}
              <p className="text-[12px] text-ink-faint">
                If your terminal says <code className="font-mono">cogworks: command not found</code>,
                the course environment is not active. Activate it and install again, or
                run <code className="font-mono">python -m cogbench</code> in place of{" "}
                <code className="font-mono">cogworks</code>.
              </p>
            </Step>

            <Step index={number()} state={machineState("project")} title="Install this project" chip={terminalSet.has("project") ? "CLI checked" : undefined}>
              <p>
                Two installs: the benchmark's pinned dependencies, then your own
                project in editable mode, so later code changes apply without
                reinstalling. This is also what registers the entry points the
                track looks for
                {moduleEntryPoints.length > 0 ? (
                  <>
                    :{" "}
                    {moduleEntryPoints.map((name, i) => (
                      <span key={name}>
                        {i > 0 && ", "}
                        <code className="font-mono text-[12px]">{name}</code>
                      </span>
                    ))}
                  </>
                ) : null}
                .
              </p>
              <Code
                lang="bash"
                code={'python -m pip install -r requirements-cogbench-pilot.txt\npython -m pip install -e .'}
              />
              <p className="text-[12px] text-ink-faint">
                Editable installation means code changes take effect without
                reinstalling. CogWorks does not create or repair your conda environment.
              </p>
            </Step>

            <Step
              state={deviceLinked ? "verified" : "pending"}
              title="Link this machine"
              chip={deviceLinked ? "linked" : undefined}
            >
              <p>
                This command opens CogPortal for approval, then returns to the
                terminal. The connection is revocable from{" "}
                <Link to="/connections" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
                  Connections
                </Link>
                .
              </p>
              <Code lang="bash" code={`cogworks link --portal ${portalOrigin}`} />
              <p className="text-[12px] text-ink-faint">
                Linking never turns on background reporting. Ordinary check,
                test, run, and report commands still leave CogPortal alone.
              </p>
            </Step>

            <Step
              index={number()}
              state={machineState("wiring")}
              title="Check the wiring"
              chip={terminalSet.has("wiring") ? "CLI checked" : undefined}
              last
            >
              <p>
                <code className="font-mono text-[12px]">check</code> verifies
                Python, the Git remote, installed benchmark package, editable
                project, and adapter discovery. It does not grade your work or
                download the large public model/data cache.
              </p>
              <Code
                lang="bash"
                code={`cogworks check --benchmark ${benchmarkId} --update-setup`}
              />
              <p className="text-[12px] text-ink-faint">
                The flag makes this one run update the guide. If local checks
                pass but CogPortal is offline, the terminal prints both outcomes,
                exits 2, and gives the same command to retry.
              </p>
            </Step>
          </ol>

          {complete ? (
            <Panel label="SETUP COMPLETE" tone="good" className="mt-8">
              <p className="text-[14px] text-ink">
                Your machine can find the starter and this track's adapter
                interfaces. You're ready to begin implementing. A working model
                isn't expected yet.
              </p>
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
              <p className="text-[12.5px] text-ink-faint">No rush. The guide keeps your place.</p>
              <Link
                to="/dashboard"
                className="u-pressable inline-flex min-h-9 items-center gap-1.5 font-mono text-[11.5px] tracking-[0.07em] text-ink-secondary uppercase hover:text-ink"
              >
                Open dashboard
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
              </Link>
            </div>
          )}

          <Panel label="THE LOOP YOU'LL USE NEXT" className="mt-6">
            <p className="text-[13.5px] leading-relaxed text-ink-secondary">
              Once you have implemented an adapter, <code className="font-mono text-[12px]">test</code>{" "}
              runs the smaller public tier and <code className="font-mono text-[12px]">run</code>{" "}
              runs the larger practice tier. First-time runs may explicitly download the public cache.
            </p>
            <div className="mt-3">
              <Code
                lang="bash"
                code={`cogworks test --benchmark ${benchmarkId} --update-setup\ncogworks run --benchmark ${benchmarkId} --update-setup\ncogworks report`}
              />
            </div>
            <p className="mt-3 font-mono text-[11px] text-ink-faint">
              Later, omit --update-setup. Practice remains LOCAL · SELF-REPORTED.
              {terminalSet.has("test") ? " FIRST TEST CHECKED." : ""}
              {terminalSet.has("run") ? " FIRST RUN CHECKED." : ""}
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ProgressRail({
  progress,
}: {
  progress: Array<{ label: string; done: boolean; unnumbered?: boolean }>;
}) {
  let ordinal = 0;
  return (
    <aside className="sticky top-8 hidden border-l border-rule-soft pl-4 lg:block" aria-label="Setup progress">
      <p className="u-kicker mb-3">Field notes</p>
      <ol className="space-y-2.5">
        {progress.map((item) => (
          <li
            key={item.label}
            role={item.unnumbered ? "presentation" : undefined}
            className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.05em] uppercase"
          >
            <span
              aria-hidden={item.unnumbered || undefined}
              className={`inline-block w-[2ch] ${item.done ? "text-verify-deep" : "text-ink-faint"}`}
            >
              {item.unnumbered ? "·" : String(++ordinal).padStart(2, "0")}
            </span>
            <span className={item.done ? "text-ink" : "text-ink-faint"}>{item.label}</span>
          </li>
        ))}
      </ol>
    </aside>
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

function Step({
  index,
  state,
  title,
  chip,
  selfCheck,
  children,
  last = false,
}: {
  index?: string;
  state: "verified" | "pending";
  title: string;
  chip?: string;
  selfCheck?: { checked: boolean; onToggle: () => void; label: string };
  children: ReactNode;
  last?: boolean;
}) {
  const done = state === "verified";
  return (
    <li
      role={index === undefined ? "presentation" : undefined}
      className={`relative flex gap-4 ${last ? "" : "pb-8"}`}
    >
      <span
        aria-hidden="true"
        className={`relative z-10 flex size-7 shrink-0 items-center justify-center border font-mono text-[11px] transition-colors duration-150 ${
          done
            ? "border-verify/50 bg-verify-wash text-verify-deep"
            : "border-rule bg-paper-raised text-ink-faint"
        }`}
      >
        {done ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2.2} /> : (index ?? "·")}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-serif text-[16.5px] font-semibold text-ink">{title}</h2>
          {chip && (
            <span className="font-mono text-[10px] tracking-[0.08em] text-verify-deep uppercase">
              {chip}
            </span>
          )}
        </div>
        <div className="mt-1.5 space-y-2.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {children}
        </div>
        {selfCheck && (
          <label className="mt-3 flex w-fit cursor-pointer items-center gap-2.5 py-1 select-none">
            <input
              type="checkbox"
              checked={selfCheck.checked}
              onChange={selfCheck.onToggle}
              className="size-4 accent-[#1c2637]"
            />
            <span className="font-mono text-[11px] tracking-[0.07em] text-ink-secondary uppercase">
              {selfCheck.label}
            </span>
          </label>
        )}
      </div>
    </li>
  );
}
