import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { SetupState, SetupStep, TeamDetail } from "@cogworks/contracts/schema";
import { Code } from "@/components/Code";
import { CopyBlock } from "@/components/CopyBlock";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import {
  DEFAULT_BENCHMARK,
  useConnections,
  useLocalReports,
  useSession,
  useSetupState,
  useTeam,
} from "@/lib/queries";
import { setupSteps, useSetupChecks } from "@/lib/setup-progress";
import type { SetupEntry } from "@/lib/setup-progress";

/**
 * The setup guide: one page from "you have a team" to "you synced a result",
 * in the order a student actually works (onboarding doc §1). The portal only
 * claims what it can see. A connected fork, a linked device, a synced report
 * earn VERIFIED on their own; the machine-local steps offer a one-line
 * terminal command that phones the portal and ticks the box, or a plain
 * checkbox if you'd rather not.
 */
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
    />
  );
}

function SetupGuide({
  team,
  login,
  entry,
}: {
  team: TeamDetail;
  login: string;
  entry: SetupEntry;
}) {
  const connections = useConnections();
  const reports = useLocalReports(DEFAULT_BENCHMARK);
  const setupState = useSetupState();
  const [checks, toggleCheck] = useSetupChecks(team.id, login);

  const teammates = team.members.length >= 2;
  const deviceLinked = (connections.data?.cliDevices.length ?? 0) > 0;
  const reportSynced = (reports.data?.length ?? 0) > 0;
  const terminal = setupState.data?.verified ?? [];
  const terminalSet = new Set<string>(terminal);

  const { done, total } = setupSteps(entry, checks, {
    teammates,
    reportSynced,
    terminal,
  });
  const complete = done === total;
  const created = entry === "created";

  /** Machine-local steps: terminal-verified beats a manual tick. */
  const machine = (step: SetupStep) => ({
    state: terminalSet.has(step)
      ? ("verified" as const)
      : checks.has(step)
        ? ("checked" as const)
        : ("pending" as const),
    chip: terminalSet.has(step) ? ("verified" as const) : undefined,
    selfCheck: terminalSet.has(step)
      ? undefined
      : { checked: checks.has(step), onToggle: () => toggleCheck(step) },
  });

  let step = 0;
  const number = () => String(++step).padStart(2, "0");

  return (
    <div className="anim-rise mx-auto w-full max-w-lg py-14">
      <p className="u-kicker">
        Getting set up · {done} of {total}
      </p>
      <h1 className="mt-1 text-3xl">
        {created ? "Your team has a home." : `You're on ${team.name}.`}
      </h1>
      <p className="mt-2 text-[14px] text-ink-secondary">
        {created
          ? `A few steps and ${team.name} is ready to run. The portal marks what it can verify; the rest is yours to check off.`
          : "A few steps and you're ready to run. The portal marks what it can verify; the rest is yours to check off."}
      </p>

      <ol className="relative mt-9">
        {/* the protocol rail */}
        <div
          aria-hidden="true"
          className="absolute top-4 bottom-4 left-[13px] w-px bg-rule-soft"
        />

        <Step
          index={number()}
          state="verified"
          title={created ? "Your fork is connected" : `You joined ${team.name}`}
          chip="verified"
        >
          <p>
            <a
              href={team.repo.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
            >
              {team.repo.fullName}
            </a>{" "}
            {created
              ? "is the team's shared record; every attempt runs from it."
              : "is the team's shared record; your work lands there."}
          </p>
        </Step>

        {created ? (
          <Step
            index={number()}
            state={teammates ? "verified" : checks.has("teammates") ? "checked" : "pending"}
            title="Bring your teammates"
            chip={teammates ? "verified" : undefined}
            selfCheck={
              teammates
                ? undefined
                : {
                    checked: checks.has("teammates"),
                    onToggle: () => toggleCheck("teammates"),
                    label: "I'm working solo for now",
                  }
            }
          >
            <p>
              Add them from{" "}
              <Link to="/team" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
                Team settings
              </Link>
              , or they can pick <em>Join a team</em> when they first sign in.
              {!teammates && " This step verifies itself when a teammate arrives."}
            </p>
          </Step>
        ) : (
          <Step
            index={number()}
            title="Get the code"
            {...machine("clone")}
          >
            <p>Clone the team's fork. You all work in the same repository.</p>
            <Code lang="bash" code={`git clone ${team.repo.url}.git\ncd ${team.repo.name}`} />
            <TerminalCheckoff step="clone" state={setupState.data} />
          </Step>
        )}

        <Step index={number()} title="Set up your environment" {...machine("environment")}>
          <p>
            From your fork's root, in the <code className="font-mono text-[12px]">week2</code>{" "}
            environment you built for the Vision prerequisites:
          </p>
          <Code
            lang="bash"
            code={
              "conda activate week2\npython -m pip install cogworks-benchmark cogworks-vision-benchmark\npython -m pip install -e ."
            }
          />
          <p className="text-[12px] text-ink-faint">
            The two cogworks packages are new; they carry the benchmark and sit
            on top of the course installs you already have. We say{" "}
            <code className="font-mono">python -m pip</code> (where CogWeb says{" "}
            <code className="font-mono">pip</code>) so the installer and your
            Python stay in the same environment.
          </p>
          <TerminalCheckoff step="environment" state={setupState.data} />
        </Step>

        <Step index={number()} title="Prove the wiring" {...machine("wiring")}>
          <p>
            <code className="font-mono text-[12px]">doctor</code> checks discovery;{" "}
            <code className="font-mono text-[12px]">test</code> runs one public case. Neither
            says anything about your score, only that CogBench can find and call
            your adapter.
          </p>
          <Code
            lang="bash"
            code={
              "cogbench doctor --benchmark vision-recognition\ncogbench test --benchmark vision-recognition"
            }
          />
          <TerminalCheckoff step="wiring" state={setupState.data} />
        </Step>

        {/* optional — outside the numbered protocol */}
        <Step
          index="—"
          state={deviceLinked ? "verified" : "pending"}
          title="Link this device"
          chip={deviceLinked ? "verified" : "optional"}
        >
          <p>
            Lets you sync self-reported results to{" "}
            <Link to="/connections" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
              Connections
            </Link>
            . It can only upload reports you choose (never your source), and you
            can revoke it any time.
          </p>
          <Code lang="bash" code="cogbench link" />
        </Step>

        <Step
          index={number()}
          state={reportSynced ? "verified" : checks.has("run") ? "checked" : "pending"}
          title="Your first local run"
          chip={reportSynced ? "verified" : undefined}
          selfCheck={
            reportSynced
              ? undefined
              : {
                  checked: checks.has("run"),
                  onToggle: () => toggleCheck("run"),
                }
          }
          last
        >
          <p>
            Local runs are always{" "}
            <span className="font-mono text-[11px]">LOCAL · SELF-REPORTED</span>. Practice
            freely; sync deliberately.
            {!reportSynced && " This step verifies itself when a report syncs."}
          </p>
          <Code
            lang="bash"
            code={"cogbench run --benchmark vision-recognition\ncogbench sync"}
          />
        </Step>
      </ol>

      {complete ? (
        <Panel label="CALIBRATION COMPLETE" tone="good" className="mt-8">
          <p className="text-[14px] text-ink">
            Everything the portal can verify checks out. If your local runs look
            healthy too, you're ready for a practice attempt.
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
          <p className="text-[12.5px] text-ink-faint">
            No rush. The guide keeps your place.
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

/* ── Terminal check-off ───────────────────────────────────────────────── */

/**
 * One line, pasted in the same terminal, and the box ticks itself: the
 * command prints the portal's confirmation and the page notices within a
 * few seconds. Explicit by design; it only marks this step, nothing else
 * is sent.
 */
function TerminalCheckoff({
  step,
  state,
}: {
  step: SetupStep;
  state: SetupState | undefined;
}) {
  const token = state?.tokens[step];
  if (!token || state?.verified.includes(step)) return null;
  const url = `${window.location.origin}/api/v1/setup/verify?t=${token}`;
  return (
    <div>
      <p className="text-[12px] text-ink-faint">
        Done here? Run this in the same terminal and the box ticks itself. (It
        only marks this step; nothing else is sent.)
      </p>
      <CopyBlock
        className="mt-1.5"
        text={`python -c "import urllib.request as u; print(u.urlopen('${url}').read().decode())"`}
      />
    </div>
  );
}

/* ── Step rail ────────────────────────────────────────────────────────── */

function Step({
  index,
  state,
  title,
  chip,
  selfCheck,
  children,
  last = false,
}: {
  index: string;
  state: "verified" | "checked" | "pending";
  title: string;
  chip?: "verified" | "optional";
  selfCheck?: { checked: boolean; onToggle: () => void; label?: string };
  children: ReactNode;
  last?: boolean;
}) {
  const doneVisual =
    state === "verified"
      ? "border-verify/50 bg-verify-wash text-verify-deep"
      : state === "checked"
        ? "border-ink bg-ink text-paper-raised"
        : "border-rule bg-paper-raised text-ink-faint";

  return (
    <li className={`relative flex gap-4 ${last ? "" : "pb-8"}`}>
      <span
        aria-hidden="true"
        className={`relative z-10 flex size-7 shrink-0 items-center justify-center border font-mono text-[11px] transition-colors duration-150 ${doneVisual}`}
      >
        {state === "pending" ? (
          index
        ) : (
          <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2.2} />
        )}
      </span>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-serif text-[16.5px] font-semibold text-ink">{title}</h2>
          {chip === "verified" && (
            <span className="anim-rise font-mono text-[10px] tracking-[0.08em] text-verify-deep uppercase">
              verified
            </span>
          )}
          {chip === "optional" && (
            <span className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
              optional
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
              {selfCheck.label ?? "Done on my machine"}
            </span>
          </label>
        )}
      </div>
    </li>
  );
}
