import type { Metric } from "@cogworks/contracts/schema";
import { formatMetricValue } from "@/lib/format";
import { CornerBrackets } from "./Brackets";

/** Direction is always explicit — the portal never assumes higher-is-better. */
function DirectionMark({ metric }: { metric: Metric }) {
  return (
    <span className="font-mono text-[11px] text-ink-faint" title={metric.higherIsBetter ? "higher is better" : "lower is better"}>
      {metric.higherIsBetter ? "▲ higher is better" : "▼ lower is better"}
    </span>
  );
}

export function PrimaryMetric({ metric }: { metric: Metric }) {
  return (
    <figure className="relative inline-block px-4 py-3">
      <CornerBrackets size={12} thickness={1.5} inset={0} className="text-detect" />
      <div className="u-kicker">{metric.label}</div>
      <div className="u-tnum mt-1 font-serif text-5xl font-semibold text-ink">
        {metric.value.toFixed(metric.precision)}
        {metric.unit && (
          <span className="ml-1 text-lg font-normal text-ink-secondary">{metric.unit}</span>
        )}
      </div>
      <figcaption className="mt-1">
        <DirectionMark metric={metric} />
      </figcaption>
    </figure>
  );
}

export function SupportingMetrics({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) return null;
  return (
    <dl>
      {metrics.map((m) => (
        <div
          key={m.key}
          className="flex items-baseline justify-between gap-4 border-b border-rule-soft py-2 last:border-b-0"
        >
          <dt className="text-[13px] text-ink-secondary">{m.label}</dt>
          <dd className="flex items-baseline gap-2">
            <span className="u-tnum font-mono text-[13px] font-medium text-ink">
              {formatMetricValue(m)}
            </span>
            <span className="font-mono text-[10px] text-ink-faint" aria-hidden="true">
              {m.higherIsBetter ? "▲" : "▼"}
            </span>
            <span className="sr-only">
              {m.higherIsBetter ? "higher is better" : "lower is better"}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
