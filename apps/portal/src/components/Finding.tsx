import { CornerBrackets } from "./Brackets";

/**
 * The sentence a run is about, set larger than the number it came from.
 *
 * A score answers "how did we do" and stops there. A team reading 0.53 with
 * no other information has to guess which half of their pipeline produced it,
 * and guessing is what this course exists to replace. The benchmarks already
 * write the sentence: the scorer's first diagnostic names the stage and the
 * cause ("the right song is still being found, so the vote is what gives way
 * as the library grows"). This puts it where the eye lands first.
 *
 * Nothing here is generated. The text arrives from the benchmark, assembled
 * from templates against measured numbers, so it can only say what the run
 * observed.
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
  // No horizontal padding of its own: Panel already supplies px-4, and a
  // second inset costs a third of the measure on a phone. The brackets sit on
  // the figure's own edge, which is the panel's text column.
  return (
    <figure className="relative py-1">
      <CornerBrackets size={14} thickness={1.5} inset={-8} className="text-detect" />
      <div className="u-kicker">What this run shows</div>
      <p className="mt-2 max-w-[58ch] font-serif text-[19px] leading-[1.45] text-ink sm:text-[21px] sm:leading-[1.4]">
        {sentence}
      </p>
      {rest.length > 0 && (
        <figcaption className="mt-4 border-t border-rule-soft pt-3">
          <ul className="space-y-1.5">
            {rest.map((note, index) => (
              <li
                key={`${index}:${note}`}
                className="flex gap-2.5 text-[13.5px] leading-relaxed text-ink-secondary"
              >
                <span aria-hidden="true" className="mt-[0.55em] size-1 shrink-0 bg-ink-faint" />
                <span className="max-w-prose">{note}</span>
              </li>
            ))}
          </ul>
        </figcaption>
      )}
    </figure>
  );
}
