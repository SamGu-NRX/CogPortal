import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "official" | "ghost" | "quiet";

/** Shared with links that should look like a button (a real `<a>` keeps its
 *  link semantics, so a GitHub fork or a page change stays a navigation). */
export function buttonClass(variant: Variant = "primary", className = "") {
  const variants: Record<Variant, string> = {
    primary:
      "bg-ink text-paper-raised hover:bg-ink/85 disabled:not-data-busy:bg-ink/35 aria-disabled:bg-ink/35",
    official:
      "bg-detect text-paper-raised hover:bg-detect-deep disabled:not-data-busy:bg-detect/40 aria-disabled:bg-detect/40",
    ghost:
      "border border-rule-strong bg-paper-raised text-ink hover:border-ink disabled:not-data-busy:border-rule disabled:not-data-busy:text-ink-faint",
    quiet:
      "text-ink-secondary hover:bg-ink/[0.045] hover:text-ink disabled:text-ink-faint",
  };
  return `u-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-5 text-[14.5px] font-semibold tracking-[0.005em] text-center transition-[background-color,border-color,color] duration-150 ease-out disabled:cursor-not-allowed ${variants[variant]} ${className}`;
}

/**
 * 44px-minimum targets. Press feedback is scale(.97) at 140ms. "official" is
 * detector red and is kept for actions with real consequence: spending an
 * official attempt, publishing a result, removing someone.
 *
 * `busy` keeps the button's color and label and adds a pulse, so a pending
 * action still says what it is doing. A grey, empty button reads as broken.
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
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${buttonClass(variant, className)} ${busy ? "disabled:cursor-progress" : ""}`}
      data-busy={busy || undefined}
    >
      {busy && (
        <span aria-hidden="true" className="anim-live inline-block size-1.5 rounded-full bg-current" />
      )}
      {children}
    </button>
  );
}
