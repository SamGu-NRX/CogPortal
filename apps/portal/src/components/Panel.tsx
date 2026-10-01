import type { ReactNode } from "react";

/**
 * A sheet on the page: raised paper inside a pencil rule, with a plain
 * sentence-case title. The title is an `h2` because every caller uses a panel
 * as a section of its page.
 *
 * `tone` is for a panel whose whole content is a verdict: "alert" when
 * something needs attention, "good" when the portal observed it working. The
 * colored edge on the left is the index tab; the wash is kept faint so text on
 * it stays at AA (see the contrast notes in styles/app.css).
 */
export function Panel({
  label,
  description,
  aside,
  children,
  className = "",
  tone = "default",
  id,
}: {
  /** Sentence-case title, e.g. "Connected repository". */
  label?: string;
  /** One line under the title saying why the panel is here. */
  description?: ReactNode;
  /** Right-aligned header slot (chips, counts, actions). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: "default" | "alert" | "good";
  id?: string;
}) {
  const toneClasses =
    tone === "alert"
      ? "border-detect/35 bg-detect-wash before:bg-detect"
      : tone === "good"
        ? "border-verify/35 bg-verify-wash before:bg-verify"
        : "border-rule bg-paper-raised before:hidden";

  return (
    <section
      id={id}
      className={`relative overflow-hidden rounded-surface border ${toneClasses} before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[''] ${className}`}
    >
      {(label || aside) && (
        <header className="flex min-h-6 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 pt-4">
          {label ? (
            <div className="min-w-0">
              <h2 className="font-sans text-[15px] font-bold tracking-[0.002em] text-ink">{label}</h2>
              {description && (
                <p className="mt-0.5 max-w-[60ch] text-[13.5px] leading-[1.5] text-ink-secondary">
                  {description}
                </p>
              )}
            </div>
          ) : (
            <span />
          )}
          {aside && <div className="flex shrink-0 items-center gap-3 pt-0.5">{aside}</div>}
        </header>
      )}
      <div className={label || aside ? "px-5 pt-3 pb-5" : "px-5 py-5"}>{children}</div>
    </section>
  );
}
