/** The label above a run's finding. Shared so a sweep that stands alone,
 *  because the scorer had nothing to add, is introduced the same way. */
export const FINDING_KICKER = "What this run shows";

/**
 * The sentence a run is about, set larger than the number it came from.
 *
 * A score answers "how did we do" and stops there. A team reading 0.53 with
 * no other information has to guess which half of their pipeline produced it,
 * and guessing is what this course exists to replace. The benchmarks already
 * write the sentence: the scorer's first diagnostic names the stage and the
 * cause ("the right song is still being found, so the vote is what gives way
 * as the library grows"). This puts it where the eye lands first, as the
 * largest type on the run page.
 *
 * Nothing here is generated. The text arrives from the benchmark, assembled
 * from templates against measured numbers, so it can only say what the run
 * observed.
 *
 * No brackets of its own: on the run page the detection bracket marks the
 * point on the trace the sentence is about, and a second pair around the
 * sentence would leave the eye two places to land.
 */
export function Finding({
  sentence,
  supporting,
}: {
  sentence: string;
  /** The rest of the scorer's notes, if any. Rendered smaller, below. */
  supporting?: string[];
}) {
  const rest = supporting ?? [];
  return (
    <figure>
      <figcaption className="u-label">{FINDING_KICKER}</figcaption>
      <p className="mt-2 max-w-[38rem] font-serif text-[24px] leading-[1.3] font-[480] tracking-[-0.01em] text-ink sm:text-[31px] sm:leading-[1.25]">
        {sentence}
      </p>
      {rest.length > 0 && (
        <ul className="mt-5 max-w-[60ch] space-y-2 border-t border-rule-soft pt-4">
          {rest.map((note, index) => (
            <li
              key={`${index}:${note}`}
              className="flex gap-3 text-[14.5px] leading-[1.55] text-ink-secondary"
            >
              <span aria-hidden="true" className="mt-[0.7em] h-px w-2.5 shrink-0 bg-ink-faint" />
              <span className="min-w-0">{note}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
