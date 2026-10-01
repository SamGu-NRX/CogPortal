import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Button } from "./Button";

const ARMED_MS = 4000;

/**
 * Two-step arm/confirm for consequential actions (spending an official
 * attempt, publishing a result), inline, no modal (plan §8). The first press
 * swaps the label for the consequence; the second carries it out.
 *
 * Arming decays after four seconds so an abandoned first click can't fire
 * later, and a hairline along the bottom edge drains over those four seconds
 * so the decay is visible rather than a surprise. Escape disarms at once,
 * the same way Escape backs out of anything else that opened.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = "official",
  busy = false,
  disabled = false,
  className = "",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: "primary" | "official";
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fuse = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The drain is linear because it is a clock: constant motion reads as time
  // passing at a constant rate. WAAPI rather than a CSS keyframe, so the
  // component carries no stylesheet of its own, and it runs off the main
  // thread like one. Under reduced motion the hairline stays still; it still
  // marks the button as armed.
  useEffect(() => {
    if (!armed || reduceMotion || !fuse.current?.animate) return;
    const animation = fuse.current.animate(
      [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
      { duration: ARMED_MS, easing: "linear", fill: "forwards" },
    );
    return () => animation.cancel();
  }, [armed, reduceMotion]);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
  };

  const click = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ARMED_MS);
      return;
    }
    disarm();
    onConfirm();
  };

  return (
    <Button
      variant={variant}
      onClick={click}
      onKeyDown={(event) => {
        if (event.key === "Escape" && armed) {
          event.stopPropagation();
          disarm();
        }
      }}
      busy={busy}
      disabled={disabled}
      className={`relative overflow-hidden ${className}`}
      aria-live="polite"
    >
      {armed ? confirmLabel : label}
      {armed && (
        <span
          ref={fuse}
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-paper-raised/70"
        />
      )}
    </Button>
  );
}
