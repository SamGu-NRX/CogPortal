import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "official" | "ghost" | "quiet";

/**
 * 44px-minimum targets (plan §8). Press feedback: scale(.97) at 120ms — the
 * interface listens. "official" is detector red: reserved for actions with
 * real consequence (spending an official attempt, publishing a result).
 */
export function Button({
  variant = "primary",
  busy = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
}) {
  const variants: Record<Variant, string> = {
    primary:
      "bg-ink text-paper-raised hover:bg-ink/90 disabled:bg-ink/40",
    official:
      "bg-detect text-paper-raised hover:bg-detect-deep disabled:bg-detect/40",
    ghost:
      "border border-rule bg-transparent text-ink hover:border-ink-secondary disabled:text-ink-faint disabled:hover:border-rule",
    quiet:
      "bg-transparent text-ink-secondary hover:text-ink disabled:text-ink-faint",
  };

  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`u-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[2px] px-5 text-[13.5px] font-medium tracking-wide transition-colors duration-150 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="anim-live inline-block size-1.5 bg-current"
        />
      )}
      {children}
    </button>
  );
}
