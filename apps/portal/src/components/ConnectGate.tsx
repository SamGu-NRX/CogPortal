import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/Button";
import type { GateOutcome, GatePhase, GateVariant } from "@/lib/activity-gate";

/** Both actions that leave for the browser carry it; the check stays here. */
const LeavesForBrowser = () => (
  <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={1.8} aria-hidden="true" />
);

const COPY: Record<
  GateVariant,
  {
    kicker: string;
    title: string;
    open: string;
    waitingTitle: string;
    check: string;
    reopen: string;
    unchanged: string;
  }
> = {
  link: {
    kicker: "One connection",
    title: "Link Cog*Portal to see your team's bench.",
    open: "Link Cog*Portal",
    waitingTitle: "Once you've linked it in the browser, check here.",
    check: "Check the link",
    reopen: "Open the link again",
    unchanged: "Discord isn't linked to a portal account yet. Finish in the browser, then check again.",
  },
  team: {
    kicker: "One step left",
    title: "You're linked, but not on a team yet.",
    open: "Finish team setup",
    waitingTitle: "Once you're on a team, check here.",
    check: "Check for your team",
    reopen: "Open team setup again",
    unchanged: "We don't see a team for you yet. Finish in the browser, then check again.",
  },
};

/**
 * The card a student sits at until the portal knows who they are.
 *
 * The primary swaps instead of gaining a neighbour: two buttons would ask the
 * student which step they are on, and the card already knows. Compact is
 * Discord's tile layout, where only the sentence and the action still fit.
 */
export function ConnectGate({
  variant,
  phase,
  outcome,
  error,
  compact,
  onOpen,
  onCheck,
}: {
  variant: GateVariant;
  phase: GatePhase;
  outcome: GateOutcome | null;
  error: string | null;
  compact: boolean;
  onOpen: () => void;
  onCheck: () => void;
}) {
  const copy = COPY[variant];
  const waiting = phase !== "idle";
  // What just happened outranks what is still true.
  const note = error ?? (outcome === "unchanged" ? copy.unchanged : null);

  return (
    <section
      className={`w-full max-w-lg rounded-surface border border-rule bg-paper-raised ${compact ? "p-4" : "p-6 sm:p-7"}`}
    >
      {!compact && <p className="u-label">{copy.kicker}</p>}
      {/* Keyed on the swap, so the new sentence rises once and repeat checks
          leave it alone. */}
      <div key={waiting ? "waiting" : "idle"} className="anim-rise">
        <h1
          className={`text-ink text-balance ${compact ? "text-[19px] leading-[1.25]" : "mt-2 text-[clamp(1.5rem,1.2rem+1.5vw,2rem)] leading-[1.2]"}`}
        >
          {waiting ? copy.waitingTitle : copy.title}
        </h1>
      </div>
      <Button
        className={compact ? "mt-4 w-full" : "mt-6"}
        busy={phase === "checking"}
        onClick={waiting ? onCheck : onOpen}
      >
        {waiting ? (phase === "checking" ? "Checking…" : copy.check) : copy.open}
        {!waiting && <LeavesForBrowser />}
      </Button>
      {waiting && !compact && (
        <p className="mt-3">
          <button
            type="button"
            className="u-link inline-flex min-h-11 items-center gap-1.5 text-[14px]"
            onClick={onOpen}
          >
            {copy.reopen}
            <LeavesForBrowser />
          </button>
        </p>
      )}
      {/* Present before it has anything to say, so a screen reader announces the
          result of a press rather than silently gaining a paragraph. */}
      <p
        role="status"
        className={`empty:mt-0 ${error ? "text-detect-deep" : "text-ink-secondary"} ${compact ? "mt-3 text-[13px]" : "mt-4 text-[14px]"}`}
      >
        {note}
      </p>
    </section>
  );
}
