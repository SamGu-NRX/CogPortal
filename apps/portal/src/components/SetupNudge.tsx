import { ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import {
  useConnections,
  useSession,
  useSetupState,
  useTeam,
} from "@/lib/queries";
import {
  dismissSetup,
  isSetupDismissed,
  nextSetupLine,
  setupCommandProgress,
  setupCommandsForTeam,
  setupStepTitle,
  stepState,
} from "@/lib/setup-progress";
import { useTrack } from "@/lib/track";
import { StepCells } from "./StepRail";

const FOCUSABLE =
  "a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * One line on the Runs page saying how much of setup is left and which step
 * is next, with a link straight to that step.
 *
 * It counts the setup page's own command sheet rather than a second measure of
 * its own. The two used to disagree (this said "2 of 6 steps done" against the
 * page's "0 of 6 verified") because this counted milestones a student never
 * typed, including the team's own existence.
 */
export function SetupNudge() {
  const team = useTeam();
  const { data: session } = useSession();
  const track = useTrack();
  const setupState = useSetupState(track.benchmarkId);
  const connections = useConnections();
  const [hidden, setHidden] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  if (hidden || !team.data || !session?.user) return null;
  const login = session.user.login;
  if (isSetupDismissed(team.data.id, login)) return null;
  // The track decides which commands exist. Setup evidence and connections
  // decide which are verified. Waiting keeps the count from renumbering itself.
  if (track.isPending || setupState.isPending || connections.isPending) return null;
  // A failed read produces the same empty evidence as a student who has done
  // nothing, and this component's whole content is a progress count. It has
  // nowhere to put an error, so it says nothing rather than something untrue;
  // the setup page is where the failure is reported and retried.
  if (setupState.isError || connections.isError) return null;

  const lines = setupCommandsForTeam({
    repo: team.data.repo,
    benchmark: track.benchmark,
    benchmarkId: track.benchmarkId,
    verifiedSteps: setupState.data?.verified,
    verifiedStepsForBenchmark: setupState.data?.verifiedByBenchmark[track.benchmarkId],
    checkedSteps: setupState.data?.checked,
    checkedStepsForBenchmark: setupState.data?.checkedByBenchmark[track.benchmarkId],
    cliDeviceCount: connections.data?.cliDevices.length ?? 0,
    portalOrigin: window.location.origin,
  });
  const { done, total } = setupCommandProgress(lines);
  const next = nextSetupLine(lines);
  if (done >= total || !next) return null;
  const teamId = team.data.id;

  const dismiss = () => {
    // The button is about to leave the page, and focus would fall back to the
    // top of the document. Hand it to whatever comes next instead.
    const here = root.current;
    const following = here
      ? [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
          (element) =>
            !here.contains(element) &&
            Boolean(here.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
        )
      : undefined;
    dismissSetup(teamId, login);
    setHidden(true);
    following?.focus();
  };

  return (
    <div
      ref={root}
      className="anim-rise mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-surface border border-rule bg-paper-raised py-1.5 pr-1.5 pl-4"
    >
      <StepCells states={lines.map((line) => stepState(line))} />
      <p className="text-[14px] text-ink-secondary">
        <span className="font-semibold text-ink">Setup</span>{" "}
        <span className="u-tnum">
          {done} of {total} done
        </span>
      </p>
      <span className="ml-auto flex items-center">
        <Link
          to={`/setup#step-${next.id}`}
          className="u-pressable inline-flex min-h-11 items-center gap-1.5 rounded-control px-2.5 text-[14px] font-semibold text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
        >
          Next: {setupStepTitle(next.id, track.benchmark?.title ?? track.benchmarkId)}
          <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
        </Link>
        <button
          type="button"
          // It doesn't come back, so the name says where setup still lives.
          aria-label="Hide this reminder for good (Setup stays in the tabs)"
          title="Hide this reminder"
          onClick={dismiss}
          className="u-pressable flex size-11 items-center justify-center rounded-control text-ink-faint transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
