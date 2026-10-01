/**
 * An attempt budget as a tally: one pencil stroke per allowed run, inked once
 * it is spent, grouped in fives the way a notebook tallies. Countable at a
 * glance without reading the number, and never a percentage bar, which would
 * turn a budget into a progress target. Official strokes are detector red
 * because they are the scarce ones.
 */
export function QuotaCells({
  used,
  limit,
  label,
  tone = "ink",
  showLabel = true,
}: {
  used: number;
  limit: number;
  /** Names the budget for assistive tech, and on screen unless hidden. */
  label: string;
  tone?: "ink" | "detect";
  /** Off when a surrounding term (a `<dt>`) already names it on screen. */
  showLabel?: boolean;
}) {
  const exhausted = used >= limit;
  const fill = tone === "detect" ? "bg-detect" : "bg-ink";
  const groups = Array.from({ length: Math.ceil(limit / 5) }, (_, g) =>
    Array.from({ length: Math.min(5, limit - g * 5) }, (_, i) => g * 5 + i),
  );
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        {showLabel && <span className="u-label">{label}</span>}
        <span
          className={`u-tnum font-mono text-[12.5px] ${exhausted ? "font-semibold text-detect-deep" : "text-ink-secondary"}`}
        >
          {used} of {limit} used
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${used} of ${limit} used`}
        className="mt-2 flex flex-wrap items-end gap-x-2.5 gap-y-1.5"
      >
        {groups.map((group) => (
          <span key={group[0]} className="flex items-end gap-[3px]">
            {group.map((i) => (
              <span
                key={i}
                className={`h-3.5 w-[3px] rounded-[1px] transition-colors duration-200 ${
                  i < used ? fill : "bg-rule-strong"
                }`}
              />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}
