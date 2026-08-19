import { useId, useState } from "react";
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
      {/* The leaderboard number is the one a team will argue about, so its
          explanation is never behind a disclosure. Set in the body serif at
          reading size: this is prose to be read, not a label to be scanned. */}
      {metric.help && (
        <p className="mt-3 max-w-[46ch] border-l border-rule-soft pl-3 font-serif text-[13px] leading-[1.55] text-ink-secondary">
          {metric.help}
        </p>
      )}
    </figure>
  );
}

/**
 * One row of the supporting-metrics list, with its explanation folded away.
 *
 * The list's job is scanning: label on the left, value on the right, aligned
 * down the column. An always-open explanation would destroy that, and a
 * tooltip would fail on touch and hide two sentences behind a hover. So the
 * row expands in place, the way a marginal note unfolds in a notebook — the
 * value column never moves, and the annotation appears beneath its own row
 * with a rule down the left, which is how a margin note is set in print.
 *
 * The whole row is the button. No help icon: an icon on every row would add
 * eleven pieces of furniture to a list whose value is its quietness, and a
 * row-sized hit target is easier to hit than a 16px glyph. The affordance is
 * a dotted underline on the label, the printer's convention for an annotated
 * term, which appears only on rows that actually carry an explanation.
 */
function SupportingMetricRow({ metric }: { metric: Metric }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const explained = Boolean(metric.help);

  const value = (
    <dd className="flex items-baseline gap-2">
      <span className="u-tnum font-mono text-[13px] font-medium text-ink">
        {formatMetricValue(metric)}
      </span>
      <span className="font-mono text-[10px] text-ink-faint" aria-hidden="true">
        {metric.higherIsBetter ? "▲" : "▼"}
      </span>
      <span className="sr-only">
        {metric.higherIsBetter ? "higher is better" : "lower is better"}
      </span>
    </dd>
  );

  if (!explained) {
    return (
      <div className="flex items-baseline justify-between gap-4 border-b border-rule-soft py-2 last:border-b-0">
        <dt className="text-[13px] text-ink-secondary">{metric.label}</dt>
        {value}
      </div>
    );
  }

  return (
    <div className="border-b border-rule-soft last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={panelId}
        className="group relative flex w-full items-baseline justify-between gap-4 py-2 text-left transition-colors duration-150 hover:bg-detect-wash/40 focus-visible:outline-none focus-visible:bg-detect-wash/40"
      >
        {/* The instrument's own motif: brackets mark where it is looking. They
            fade in on hover and stay while the note is open. */}
        <CornerBrackets
          size={7}
          thickness={1}
          inset={-2}
          className={`text-detect transition-opacity duration-150 ${
            open ? "opacity-100" : "opacity-0 group-hover:opacity-60"
          }`}
        />
        <dt className="text-[13px] text-ink-secondary decoration-rule decoration-dotted underline-offset-[3px] group-hover:text-ink group-hover:underline">
          {metric.label}
        </dt>
        {value}
      </button>
      {/* 0fr -> 1fr animates to the content's natural height without measuring
          it in JS, so a two-line note and a five-line note both open at the
          same speed. */}
      <div
        id={panelId}
        className="grid transition-[grid-template-rows] duration-200 ease-out-quart motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p
            className={`mb-2 max-w-[52ch] border-l border-detect/25 pl-3 font-serif text-[12.5px] leading-[1.55] text-ink-secondary transition-opacity duration-200 motion-reduce:transition-none ${
              open ? "opacity-100 delay-75" : "opacity-0"
            }`}
          >
            {metric.help}
          </p>
        </div>
      </div>
    </div>
  );
}

export function SupportingMetrics({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) return null;
  return (
    <dl>
      {metrics.map((metric) => (
        <SupportingMetricRow key={metric.key} metric={metric} />
      ))}
    </dl>
  );
}
