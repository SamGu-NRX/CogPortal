import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";

/**
 * Two-step arm/confirm for consequential actions (spending an official
 * attempt, publishing a result) — inline, no modal (plan §8). Arming decays
 * after 4s so an abandoned first click can't fire later.
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

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const click = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    onConfirm();
  };

  return (
    <Button
      variant={variant}
      onClick={click}
      busy={busy}
      disabled={disabled}
      className={className}
      aria-live="polite"
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
