import type { ReactNode } from "react";

/**
 * The margin voice: the reason for the thing beside it, in the course's own
 * register (docs/design/voice.md, "say why before saying what").
 *
 * A page puts the work in its main column and the why in a note, so the work
 * stays scannable and the reason is still one glance away. `Annotated` places
 * the note in the right margin from 1024px and above the work below that; the
 * DOM order is note first either way, so a screen reader hears the reason
 * before the instruction, the way the course writes it.
 *
 * A note is prose, not a label. If it would say nothing a student doesn't
 * already know, leave it out rather than filling the margin.
 */
export function Annotated({
  note,
  children,
  className = "",
}: {
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  // One tree whether or not there is a note: the note slot holds its place,
  // so a note that arrives late (RunDetailPage's comparison line) adds a
  // sibling instead of remounting the work, which would drop focus inside it.
  return (
    <div className={`${note ? "annotated " : ""}${className}`}>
      {note ? <div className="annotated-note u-note">{note}</div> : null}
      <div className={note ? "annotated-body" : undefined}>{children}</div>
    </div>
  );
}

/** A standalone margin-style note, for a reason that sits under its work
 *  rather than beside it (a narrow page, a dialog). */
export function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`u-note border-l border-rule pl-3.5 ${className}`}>{children}</p>;
}

/**
 * Where you are, what this page is, and why it's worth your time, in that
 * order. `eyebrow` names the place (the team, "Setup"); `lede` is the one
 * sentence that earns the page. `actions` sit at the right on a wide screen
 * and drop under the title on a narrow one.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
  className = "",
  titleId,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-x-8 gap-y-4 ${className}`}>
      <div className="min-w-0 max-w-[42rem] flex-[1_1_28rem]">
        {eyebrow && <div className="u-eyebrow mb-2">{eyebrow}</div>}
        <h1 id={titleId} className="text-[clamp(2rem,1.5rem+2vw,2.75rem)] text-ink">
          {title}
        </h1>
        {lede && (
          <p className="mt-3 max-w-[58ch] text-[16px] leading-[1.6] text-ink-secondary">{lede}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}
