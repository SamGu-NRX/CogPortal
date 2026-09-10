import { Button } from "@/components/Button";
import type { GateOutcome, GatePhase, GateVariant } from "@/lib/activity-gate";

const COPY: Record<
  GateVariant,
  {
    kicker: string;
    title: string;
    body: string;
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
    body: "Cog*Portal knows you by your GitHub sign-in, which lives in your browser, so the link happens there.",
    open: "Link Cog*Portal ↗",
    waitingTitle: "Once you've linked it in the browser, check here.",
    check: "Check the link",
    reopen: "Open the link again ↗",
    unchanged: "Discord isn't linked to a portal account yet. Finish in the browser, then check again.",
  },
  team: {
    kicker: "One step left",
    title: "You're linked, but not on a team yet.",
    body: "Connect your fork in the browser to join or start your team.",
    open: "Finish team setup ↗",
    waitingTitle: "Once you're on a team, check here.",
    check: "Check for your team",
    reopen: "Open team setup again ↗",
    unchanged: "You're linked, but we don't see a team for you yet. Finish in the browser, then check again.",
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
      className={`w-full max-w-lg border border-rule bg-paper-raised ${compact ? "p-5" : "p-7"}`}
    >
      {!compact && <div className="u-kicker">{copy.kicker}</div>}
      {/* Keyed on the swap, so the new sentence rises once and repeat checks
          leave it alone. */}
      <div key={waiting ? "waiting" : "idle"} className="anim-rise">
        <h1 className={compact ? "text-xl" : "mt-3 text-4xl"}>
          {waiting ? copy.waitingTitle : copy.title}
        </h1>
        {!waiting && !compact && (
          <p className="mt-4 text-[14px] text-ink-secondary">{copy.body}</p>
        )}
      </div>
      <Button
        className="mt-6"
        busy={phase === "checking"}
        onClick={waiting ? onCheck : onOpen}
      >
        {waiting ? (phase === "checking" ? "Checking…" : copy.check) : copy.open}
      </Button>
      {waiting && !compact && (
        <p className="mt-4">
          <button
            type="button"
            className="text-[12px] text-ink-secondary underline underline-offset-2"
            onClick={onOpen}
          >
            {copy.reopen}
          </button>
        </p>
      )}
      {/* Present before it has anything to say, so a screen reader announces the
          result of a press rather than silently gaining a paragraph. */}
      <p role="status" className="mt-4 text-[13px] text-ink-secondary empty:mt-0">
        {note}
      </p>
    </section>
  );
}
