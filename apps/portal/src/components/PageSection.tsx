import type { ReactNode } from "react";
import { Annotated } from "./Note";

/**
 * A section of a page that is not a stack of boxes: a pencil rule, a serif
 * title, the work under it, and the reason for it in the margin.
 *
 * The rule and title sit above the note, so on a phone, where the note
 * stacks over the work, it reads as this section's and not as the tail of
 * the one before. Below 1024px the work runs the full page width, so the
 * rule does too; from 1024px it stops where the work's column does.
 * `aside` sits at the right of the title row (a count, the
 * section's one action).
 */
export function PageSection({
  id,
  title,
  aside,
  note,
  children,
}: {
  /** Heading id; the section is labelled by it. */
  id: string;
  title: ReactNode;
  aside?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-12 sm:mt-14">
      <div className="border-t border-rule pt-5 lg:max-w-[42rem]">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id={id} className="text-[1.375rem] text-ink">
            {title}
          </h2>
          {aside}
        </div>
      </div>
      <Annotated note={note} className="mt-2">
        {children}
      </Annotated>
    </section>
  );
}
