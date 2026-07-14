import type { ReactNode } from "react";

/**
 * Instrument panel: raised paper, one thin rule, a mono kicker label in the
 * header — deliberately grouped instrumentation, not interchangeable cards.
 */
export function Panel({
  label,
  aside,
  children,
  className = "",
  tone = "default",
}: {
  /** Mono uppercase instrument label, e.g. "CONNECTED SOURCE". */
  label?: string;
  /** Right-aligned header slot (chips, counts, actions). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: "default" | "alert" | "good";
}) {
  const toneClasses =
    tone === "alert"
      ? "border-detect/40 bg-detect-wash"
      : tone === "good"
        ? "border-verify/40 bg-verify-wash"
        : "border-rule bg-paper-raised";

  return (
    <section className={`relative border ${toneClasses} ${className}`}>
      {(label || aside) && (
        <header className="flex min-h-10 items-center justify-between gap-3 border-b border-rule-soft px-4 py-2">
          {label ? <h2 className="u-kicker">{label}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
