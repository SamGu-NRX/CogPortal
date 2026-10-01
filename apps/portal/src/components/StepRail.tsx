import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useReducedMotion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EASE_OUT_STRONG } from "@/lib/motion";
import { Annotated } from "./Note";

/**
 * The numbered rail the setup guide is worked down: one row per command, its
 * mark on the left, the command and its reason on the right.
 *
 * A row says what it is for at the call site rather than from a table in here,
 * so the page that knows the track writes the sentence and this file stays a
 * layout.
 */
export function StepRail({ children }: { children: ReactNode }) {
  return (
    // A row's body starts 2.75rem in (the mark and its gap), so the working
    // column is that much narrower than the page's. Narrowing the measure here
    // is what keeps each step's margin note in the same column as the notes
    // outside the rail.
    <div className="relative [--measure:calc(42rem_-_2.75rem)]">
      {/* the rail itself. A sibling of the list rather than a child of it,
          because `ol` takes only `li`. */}
      <div aria-hidden="true" className="absolute top-4 bottom-4 left-[13.5px] w-px bg-rule" />
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

const isDone = (state: StepState) => state === "verified" || state === "checked";

const SPOKEN: Record<StepState, string> = {
  verified: "Verified. ",
  checked: "Checked off from your terminal. ",
  unknown: "Progress unknown. ",
  pending: "Not verified yet. ",
};

export function Step({
  id,
  index,
  state,
  title,
  note,
  current = false,
  folded = false,
  children,
  last = false,
}: {
  id?: string;
  index: string;
  state: StepState;
  title: string;
  /** The reason for the step, set in the margin beside its command. */
  note?: ReactNode;
  /** The step a student is on: the first one nothing has ticked. */
  current?: boolean;
  /** Start with the command put away. Read once, when the row mounts; a step
   *  that is not ticked shows its command regardless, since it is still owed. */
  folded?: boolean;
  children: ReactNode;
  last?: boolean;
}) {
  const [open, setOpen] = useState(!folded);
  const bodyId = useId();
  const done = isDone(state);
  const showBody = open || !done;
  const mark = useRef<HTMLSpanElement>(null);
  const tick = useRef<SVGPathElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const previous = useRef(state);

  // The tick is the page's one animation, and it plays only when a box fills
  // while the student is looking: the mark is stamped, the pen draws the
  // tick, then the words say who saw it. A box that was already ticked when
  // the page opened, or one that comes back from a failed read, just shows.
  // useLayoutEffect, so the filled state never paints a frame before the
  // animation that starts from empty.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before === state || reduceMotion || !done) return;
    if (before !== "pending" && before !== "checked") return;
    const easing = `cubic-bezier(${EASE_OUT_STRONG.join(",")})`;
    mark.current?.animate([{ transform: "scale(0.86)" }, { transform: "scale(1)" }], {
      duration: 240,
      easing,
    });
    if (!isDone(before)) {
      tick.current?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
        duration: 280,
        delay: 70,
        easing,
        fill: "backwards",
      });
    }
    label.current?.animate(
      [
        { opacity: 0, transform: "translateY(3px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 200, delay: 180, easing, fill: "backwards" },
    );
  }, [state, done, reduceMotion]);

  // Observed reads heavier than self-reported, not lighter. A filled mark is
  // the portal's stamp; an outline is the student's own pen.
  const tone =
    state === "verified"
      ? "border-verify bg-verify text-paper-raised"
      : state === "checked"
        ? "border-ink bg-paper-raised text-ink"
        : state === "unknown"
          ? "border-rule bg-paper-sunken text-ink-faint"
          : current
            ? "border-ink bg-paper-raised text-ink"
            : "border-rule-strong bg-paper-raised text-ink-faint";

  return (
    <li
      id={id}
      aria-current={current ? "step" : undefined}
      className={`relative flex scroll-mt-28 gap-4 ${last ? "" : showBody ? "pb-10" : "pb-6"}`}
    >
      <span
        ref={mark}
        aria-hidden="true"
        className={`relative z-10 flex size-7 shrink-0 items-center justify-center rounded-control border transition-colors duration-200 ${tone}`}
      >
        <svg
          viewBox="0 0 16 16"
          className={`absolute size-4 ${done ? "" : "invisible"}`}
          fill="none"
        >
          <path
            ref={tick}
            d="M3.4 8.6 6.5 11.5 12.6 4.7"
            pathLength={1}
            stroke="currentColor"
            strokeWidth={state === "verified" ? 2.1 : 1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={1}
            strokeDashoffset={done ? 0 : 1}
          />
        </svg>
        {!done && (
          <span className="font-serif text-[14px] leading-none italic">
            {state === "unknown" ? "?" : index}
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 max-w-[var(--measure)] items-center">
          {/* The mark is decorative, so the state has to reach a screen reader
              in words. */}
          <span className="sr-only">{SPOKEN[state]}</span>
          <h2
            className="min-w-0 flex-1 font-serif text-[18px] leading-snug font-semibold text-ink"
            tabIndex={-1}
          >
            {done ? (
              // A ticked step's whole row is the disclosure, the way an
              // accordion heading is, so the target is the row and not a
              // small link at its end.
              <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen((value) => !value)}
                className="group -my-2 flex min-h-11 w-full items-center gap-3 rounded-control text-left"
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
                  <span>{title}</span>
                  {/* Seen, not heard: the sr-only line above already said it. */}
                  <span
                    ref={label}
                    aria-hidden="true"
                    className={`font-sans text-[13px] font-semibold ${
                      state === "verified" ? "text-verify-deep" : "text-ink-secondary"
                    }`}
                  >
                    {state === "verified" ? "Seen by the portal" : "Checked off by you"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 font-sans text-[13px] font-semibold text-ink-secondary transition-colors duration-150 group-hover:text-ink">
                  <span className="max-sm:sr-only">{open ? "Hide command" : "Show command"}</span>
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={15}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    className={open ? "rotate-180" : undefined}
                  />
                </span>
              </button>
            ) : (
              // The one highlighter stroke on the page: where you are.
              <span
                className={
                  current
                    ? "-mx-0.5 box-decoration-clone bg-[linear-gradient(transparent_56%,var(--color-marker)_56%,var(--color-marker)_92%,transparent_92%)] px-0.5"
                    : undefined
                }
              >
                {title}
              </span>
            )}
          </h2>
        </div>

        {showBody && (
          <div id={bodyId} className="mt-2">
            <Annotated note={note}>
              <div
                className={`space-y-3 text-[14px] leading-[1.6] ${
                  done ? "text-ink-faint" : "text-ink-secondary"
                }`}
              >
                {children}
              </div>
            </Annotated>
          </div>
        )}
      </div>
    </li>
  );
}

/** Five small squares, one per step, coloured the way the marks are. For a
 *  place that has no room for the rail itself. */
export function StepCells({
  states,
  className = "",
}: {
  states: readonly StepState[];
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`inline-flex items-center gap-[3px] ${className}`}>
      {states.map((state, index) => (
        <span
          key={index}
          className={`size-2.5 rounded-[2px] transition-colors duration-200 ${
            state === "verified"
              ? "bg-verify"
              : state === "checked"
                ? "border border-ink bg-ink/25"
                : "border border-rule-strong bg-paper-raised"
          }`}
        />
      ))}
    </span>
  );
}
