import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

/**
 * The numbered rail the setup guide is worked down: one row per command, its
 * mark on the left, what it is for and the command itself on the right.
 *
 * A row says what it is for at the call site rather than from a table in here,
 * so the page that knows the track writes the sentence and this file stays a
 * layout. That is how the guide read before the sheet replaced it.
 */
export function StepRail({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {/* the protocol rail. A sibling of the list rather than a child of it,
          because `ol` takes only `li`. */}
      <div aria-hidden="true" className="absolute top-4 bottom-4 left-[13px] w-px bg-rule-soft" />
      {/* Preflight strips list-style, and an unstyled list stops being announced
          as a list in VoiceOver, so the role puts the structure back. */}
      <ol role="list">{children}</ol>
    </div>
  );
}

/**
 * Verified is observed: a linked device reported it. Checked is the student
 * telling us, from their own terminal, that they did it. Both are ticks and
 * they do not look the same, because only one of them is something CogPortal
 * saw. Unknown is a read that failed, which is not the same as work nobody
 * did: both produce an empty verified set.
 */
export type StepState = "verified" | "checked" | "pending" | "unknown";

export function Step({
  index,
  state,
  title,
  children,
  last = false,
}: {
  index: string;
  state: StepState;
  title: string;
  children: ReactNode;
  last?: boolean;
}) {
  // Observed reads heavier than self-reported, not lighter. A filled mark is
  // the portal's stamp; an outline is the student's own pen.
  const mark =
    state === "verified"
      ? "border-verify bg-verify text-paper-raised"
      : state === "checked"
        ? "border-ink bg-paper-raised text-ink"
        : "border-rule bg-paper-raised text-ink-faint";

  return (
    <li className={`relative flex gap-4 ${last ? "" : "pb-8"}`}>
      <span
        aria-hidden="true"
        className={`relative z-10 flex size-7 shrink-0 items-center justify-center border font-mono text-[11px] transition-colors duration-150 ${mark}`}
      >
        {state === "verified" || state === "checked" ? (
          <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2.2} />
        ) : state === "unknown" ? (
          "?"
        ) : (
          index
        )}
      </span>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* The mark is decorative, so the state has to reach a screen reader
              in words. */}
          <span className="sr-only">
            {state === "verified"
              ? "Verified. "
              : state === "checked"
                ? "Checked off from your terminal. "
                : state === "unknown"
                  ? "Progress unknown. "
                  : "Not verified yet. "}
          </span>
          <h2 className="font-serif text-[16.5px] font-semibold text-ink">{title}</h2>
          {state === "verified" && (
            <span className="anim-rise font-mono text-[10px] tracking-[0.08em] text-verify-deep uppercase">
              verified
            </span>
          )}
          {state === "checked" && (
            <span className="anim-rise font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
              checked off
            </span>
          )}
        </div>

        <div className="mt-1.5 space-y-2.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {children}
        </div>
      </div>
    </li>
  );
}
