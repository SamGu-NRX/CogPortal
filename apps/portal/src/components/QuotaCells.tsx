/**
 * Attempt budget as discrete instrument cells — countable at a glance, not a
 * percentage bar. Official cells are detector red: they are the scarce ones.
 */
export function QuotaCells({
  used,
  limit,
  label,
  tone = "ink",
}: {
  used: number;
  limit: number;
  label: string;
  tone?: "ink" | "detect";
}) {
  const exhausted = used >= limit;
  const fill = tone === "detect" ? "bg-detect" : "bg-ink";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="u-kicker">{label}</span>
        <span
          className={`u-tnum font-mono text-[12px] ${exhausted ? "text-detect-deep font-medium" : "text-ink-secondary"}`}
        >
          {used}/{limit} used
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${used} of ${limit} used`}
        className="mt-2 flex flex-wrap gap-1"
      >
        {Array.from({ length: limit }, (_, i) => (
          <span
            key={i}
            className={`h-3 w-4 transition-colors duration-200 ${
              i < used ? fill : "border border-rule bg-transparent"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
