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

export function PrimaryMetric({
  metric,
  floors = [],
}: {
  metric: Metric;
  /**
   * The floors this number should be read against, drawn as its scale.
   *
   * The primary is lifted out of the supporting list before that list renders
   * (RunDetailPage), so a floor pointing at it has no row to fold into and
   * would otherwise sit at the bottom of the page as a bare number. Week 1
   * declares two of them, and its own help text says reading them together is
   * the point: chance is what guessing scores, and the trivial baseline is
   * what a pipeline that does none of the capstone scores.
   */
  floors?: Metric[];
}) {
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
      {floors.length > 0 && (
        /* Printed at the primary's precision, because the comparison is the
           reason they are here. No arrow on any of them: a floor is a property
           of the dataset, so there is no direction the submission controls. */
        <dl className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {floors.map((floor) => (
            <div key={floor.key} className="flex items-baseline gap-1.5">
              <dt className="font-mono text-[10px] tracking-[0.06em] text-ink-faint uppercase">
                {floor.label}
              </dt>
              <dd className="u-tnum font-mono text-[11px] text-ink-secondary">
                {formatMetricValue({ ...floor, precision: metric.precision })}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {/* The floor's own explanation, which moved here with it. A supporting
          row could unfold its note; this block cannot, so without this the
          benchmark computes the sentence, the runner sends it, the worker
          stores it, and the page drops it. That is the failure shape this
          repository has hit twice before. Open rather than behind a
          disclosure, for the reason the primary's own help is open. */}
      {floors.some((floor) => floor.help) && (
        <dl className="mt-3 max-w-[46ch] border-l border-rule-soft pl-3">
          {floors
            .filter((floor) => floor.help)
            .map((floor) => (
              <div key={floor.key} className="mt-2 first:mt-0">
                <dt className="font-mono text-[10px] tracking-[0.06em] text-ink-faint uppercase">
                  {floor.label}
                </dt>
                <dd className="font-serif text-[12.5px] leading-[1.55] text-ink-secondary">
                  {floor.help}
                </dd>
              </div>
            ))}
        </dl>
      )}
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
function SupportingMetricRow({
  metric,
  floors = [],
  subordinate = false,
}: {
  metric: Metric;
  /** Rendered as this metric's scale rather than as rows of their own. A
   *  metric can declare more than one: week 1 publishes a chance baseline and
   *  a trivial baseline against the same score, and reading them together is
   *  the point of having both. */
  floors?: Metric[];
  /** A probe reported beside the score it shadows, indented under it. */
  subordinate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const explained = Boolean(metric.help);

  const value = (
    <dd className="flex items-baseline gap-2">
      <span className="u-tnum font-mono text-[13px] font-medium text-ink">
        {formatMetricValue(metric)}
      </span>
      {/* The scale the number sits on, not a reading of its own. A floor was
          its own row with an arrow saying "higher is better", which is advice
          to raise a number the submission does not control, and it left the
          comparison the floor exists for as manual work. One floor is just
          "floor"; two need their own names, because "floor" cannot tell them
          apart. */}
      {floors.map((floor) => (
        <span key={floor.key} className="u-tnum font-mono text-[11px] text-ink-faint">
          {floors.length === 1 ? "floor" : floor.label.toLowerCase()}{" "}
          {formatMetricValue({ ...floor, precision: metric.precision })}
        </span>
      ))}
      {metric.role === "reported" ? (
        /* No arrow. This one is run and deliberately not scored, so there is
           no direction of better: high means the query text was matched
           rather than its meaning, which is the opposite of good. */
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          not scored
        </span>
      ) : metric.role === "floor" ? null : (
        <>
          <span className="font-mono text-[10px] text-ink-faint" aria-hidden="true">
            {metric.higherIsBetter ? "▲" : "▼"}
          </span>
          <span className="sr-only">
            {metric.higherIsBetter ? "higher is better" : "lower is better"}
          </span>
        </>
      )}
    </dd>
  );

  // Indented and quieter, so the eye reads it as belonging to the row above
  // rather than as another result.
  const rowPadding = subordinate ? "py-1.5 pl-4" : "py-2";

  if (!explained) {
    return (
      <div
        className={`flex items-baseline justify-between gap-4 border-b border-rule-soft last:border-b-0 ${rowPadding}`}
      >
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
        className={`group relative flex w-full items-baseline justify-between gap-4 text-left transition-colors duration-150 hover:bg-detect-wash/40 focus-visible:outline-none focus-visible:bg-detect-wash/40 ${rowPadding}`}
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

/**
 * The supporting table, arranged by what each number is rather than by the
 * order the scorer happened to return it in.
 *
 * Week 3 publishes sixteen metrics: four scored, three floors, two probes
 * that are run and deliberately not scored, and seven diagnostics. Drawn as
 * one flat list they were indistinguishable, and two of them are homonyms
 * whose difference is the whole point: `retrieval_mrr` is the score and
 * `retrieval_mrr_verbatim` is what a submission scores by looking the answer
 * up in the file it was handed. A student reading the second as the first
 * reads their result as its opposite.
 *
 * So a floor renders as the scale of the metric it belongs to, and a
 * reported probe renders directly beneath the score it shadows. The gap
 * between those two is the reading, and adjacency is what makes it one.
 *
 * This reads `role` and `relatesTo` off the metric and never a metric's
 * name, so a benchmark that grows a floor gets this for free and one that
 * declares nothing renders exactly as it did before.
 */
export function SupportingMetrics({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) return null;

  const floors = new Map<string, Metric[]>();
  const reported = new Map<string, Metric[]>();
  for (const metric of metrics) {
    if (!metric.relatesTo) continue;
    if (metric.role === "floor") {
      floors.set(metric.relatesTo, [...(floors.get(metric.relatesTo) ?? []), metric]);
    }
    if (metric.role === "reported") {
      reported.set(metric.relatesTo, [...(reported.get(metric.relatesTo) ?? []), metric]);
    }
  }

  // Anything paired to another metric has moved into that metric's row, and
  // anything plotted is read off the curve above, where its exact value is
  // printed beside its point. A row for it would be the same number twice.
  //
  // "Moved into" is checked, not assumed, because the parent can be absent:
  // week 3 withholds `retrieval_mrr` when the image side is unmeasured and
  // still sends `chance_mrr`, and a parent that is the run's primary metric
  // renders above this component (RunDetailPage separates them). Dropping the
  // child in either case deletes the number from the page entirely.
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  // A child can only move into a parent that is itself drawn as a row. Two
  // passes, because "drawn" depends on absorption: with `floor_b → floor_a →
  // score`, floor_a moves into score's row, so floor_b has nowhere to go and
  // keeps its own. A metric pointing at itself is nobody's child.
  const children = new Set(
    metrics
      .filter((metric) => {
        if (!metric.relatesTo || metric.relatesTo === metric.key) return false;
        if (metric.role !== "floor" && metric.role !== "reported") return false;
        const parent = byKey.get(metric.relatesTo);
        return Boolean(parent) && parent?.role !== "plotted";
      })
      .map((metric) => metric.key),
  );
  const absorbed = new Set(
    [...children].filter((key) => !children.has(byKey.get(key)!.relatesTo!)),
  );

  const rows = metrics.filter(
    (metric) => metric.role !== "plotted" && !absorbed.has(metric.key),
  );
  // Diagnostics last, and separated, because they describe one component in
  // more detail rather than answering "how did I do". A benchmark that
  // declares no roles keeps its original order, since every metric sorts
  // equally.
  const ordered = [
    ...rows.filter((metric) => metric.role !== "diagnostic"),
    ...rows.filter((metric) => metric.role === "diagnostic"),
  ];
  const firstDiagnostic = ordered.findIndex((metric) => metric.role === "diagnostic");

  return (
    <dl>
      {ordered.map((metric, index) => (
        <div
          key={metric.key}
          className={
            index === firstDiagnostic && index > 0 ? "mt-3 border-t border-rule pt-1" : undefined
          }
        >
          <SupportingMetricRow metric={metric} floors={floors.get(metric.key)} />
          {(reported.get(metric.key) ?? []).map((probe) => (
            <SupportingMetricRow key={probe.key} metric={probe} subordinate />
          ))}
        </div>
      ))}
    </dl>
  );
}
