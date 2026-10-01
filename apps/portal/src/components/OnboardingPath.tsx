import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { EASE_OUT_STRONG } from "@/lib/motion";

/**
 * Where a student is in getting started. The four steps happen in this order
 * and each needs the one before it, so they are numbered; a student who has
 * never heard the word "cohort" can still see that it comes after signing in
 * and before the team.
 *
 * Steps are not links. A finished step can't be redone from here (you can't
 * sign in twice) and a later one can't be skipped, so a link would only lead
 * to a redirect.
 */
const STEPS = [
  { id: "signin", label: "Sign in" },
  { id: "cohort", label: "Cohort" },
  { id: "team", label: "Team" },
  { id: "setup", label: "Set up" },
] as const;

export type OnboardingStep = (typeof STEPS)[number]["id"];

export function OnboardingPath({
  current,
  className = "",
}: {
  current: OnboardingStep;
  className?: string;
}) {
  const at = STEPS.findIndex((step) => step.id === current);

  return (
    // An ordered list rather than a nav: nothing here is a link. Preflight
    // strips list-style, so the role puts the list back for VoiceOver.
    <div className={className}>
      <ol role="list" aria-label="Getting started" className="grid grid-cols-4 gap-2">
        {STEPS.map((step, index) => {
          const done = index < at;
          const here = index === at;
          return (
            <li
              key={step.id}
              aria-current={here ? "step" : undefined}
              className="min-w-0"
            >
              {/* The rule is the progress: ink up to and including where you
                  are. Only the current one draws in, once, so arriving on a
                  step is the one thing that moves. MotionConfig's
                  reducedMotion="user" drops the transform. */}
              <span aria-hidden="true" className="relative block h-[2px] overflow-hidden rounded-full bg-rule">
                {(done || here) && (
                  <motion.span
                    className="absolute inset-0 origin-left bg-ink"
                    initial={here ? { transform: "scaleX(0)" } : false}
                    animate={{ transform: "scaleX(1)" }}
                    transition={{ duration: 0.26, ease: EASE_OUT_STRONG, delay: 0.08 }}
                  />
                )}
              </span>
              <span
                className={`mt-2 flex items-baseline gap-1.5 text-[13px] leading-tight ${
                  here ? "font-semibold text-ink" : "text-ink-faint"
                }`}
              >
                <span aria-hidden="true" className="u-tnum font-serif italic">
                  {index + 1}.
                </span>
                <span className="min-w-0 truncate">
                  <span className="sr-only">
                    Step {index + 1} of {STEPS.length}:{" "}
                  </span>
                  {step.label}
                  {done && <span className="sr-only"> (done)</span>}
                </span>
                {done && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={13}
                    strokeWidth={2}
                    className="shrink-0 self-center text-ink-faint"
                    aria-hidden="true"
                  />
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
