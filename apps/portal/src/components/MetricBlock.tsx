import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import type { Metric } from "@cogworks/contracts/schema";
import { formatMetricValue } from "@/lib/format";
import { CornerBrackets } from "./Brackets";

function DirectionArrow({ higherIsBetter, size }: { higherIsBetter: boolean; size: number }) {
  return (
    <HugeiconsIcon
      icon={higherIsBetter ? ArrowUp01Icon : ArrowDown01Icon}
      size={size}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}

function directionLabel(metric: Metric): string {
  return metric.higherIsBetter ? "higher is better" : "lower is better";
}

/**
 * Whether this metric may claim a direction at all.
 *
 * Three reasons it may not, and they are different reasons:
 *
 * - A floor is a property of the dataset. The submission cannot move it, so
 *   "higher is better" on one is advice to change the corpus.
 * - The run recorded no roles at all. Before the portal stored `role`, a floor
 *   and a scored metric arrived identical, so a stored week 3 result draws
 *   "higher is better" on its three chance baselines. We cannot tell which is
 *   which without guessing, so nothing claims a direction for that run. The
 *   values are untouched; only the claim is withheld. A benchmark that has
 *   never declared roles pays the same price, and declaring them removes it.
 * - A reported metric is deliberately outside the score. That is a separate
 *   fact from which way is better, so it keeps its direction when the
 *   benchmark actually stated one. Only "lower is better" is treated as a
 *   statement: producers compute `higher_is_better = key not in
 *   lower_is_better`, so `true` is what an unclassified key gets by default.
 *   Week 1's median identify time keeps its lower-is-better mark; week 3's
 *   verbatim probes, whose higher really is worse, show none.
 *
 *   This is deliberately conservative and it is wrong about one real metric.
 *   Week 1's `margin_separation` is reported, is absent from
 *   `lower_is_better`, and its own help says a high value is a usable
 *   confidence signal, so higher genuinely is better and this rule denies it
 *   an arrow. Nothing regressed (a reported metric never had one), but the
 *   rule under-claims there, and the honest fix is for a benchmark to say
 *   "no direction" itself rather than for the portal to infer it from a
 *   producer's default. That needs a contract field and is not this change.
 */
export function claimsDirection(metric: Metric, rolesRecorded: boolean): boolean {
  if (metric.role === "floor") return false;
  if (metric.role == null && !rolesRecorded) return false;
  if (metric.role === "reported") return metric.higherIsBetter === false;
  return true;
}

/**
 * The change against the same metric in the team's previous comparable run.
 *
 * Printed in the metric's own precision and unit, and never colored: a green
 * "+0.002" reads as praise, which is the judge's job and not the
 * instrument's. Which way is better is already on the row.
 * Null when there is nothing to compare, so no row claims a change it cannot
 * show.
 */
function formatChange(metric: Metric, previous: Metric | undefined): string | null {
  if (!previous) return null;
  const magnitude = Math.abs(metric.value - previous.value).toFixed(metric.precision);
  if (Number(magnitude) === 0) return "same";
  const sign = metric.value > previous.value ? "+" : "−";
  return `${sign}${magnitude}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function Change({ text }: { text: string | null }) {
  return (
    <span className="u-tnum w-[7ch] shrink-0 text-right font-mono text-[12px] text-ink-faint">
      {text && (
        <>
          <span className="sr-only">change since the previous run: </span>
          {text}
        </>
      )}
    </span>
  );
}

/**
 * The run's headline reading, at reading size rather than poster size.
 *
 * It sits under the finding and the trace, where a reading sits under the
 * thing that explains it (docs/design/the-instrument-not-the-judge.md, item
 * 5). It is still the first row of the readings, slightly larger, because it
 * is the number the leaderboard shows and a team will look for it.
 */
export function PrimaryMetric({
  metric,
  floors = [],
  rolesRecorded = true,
  previous,
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
  /** Whether this run recorded any metric roles. See `claimsDirection`. */
  rolesRecorded?: boolean;
  /** The same metric in the run this one is compared against. Null when
   *  there is a comparison run without this metric; absent when there is no
   *  comparison at all, which also drops the change slot. */
  previous?: Metric | null;
}) {
  const change = formatChange(metric, previous ?? undefined);
  return (
    <figure className="py-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <figcaption className="min-w-0">
          <span className="text-[15px] font-semibold text-ink">{metric.label}</span>
          {claimsDirection(metric, rolesRecorded) && (
            <span className="ml-2.5 inline-flex items-center gap-1 font-mono text-[12px] text-ink-faint">
              <DirectionArrow higherIsBetter={metric.higherIsBetter} size={11} />
              {directionLabel(metric)}
            </span>
          )}
        </figcaption>
        {/* ml-auto keeps the value on the right edge when a narrow screen
            wraps it under the label, so the change column stays one column. */}
        <div className="ml-auto flex items-baseline gap-2.5">
          <span className="u-tnum font-mono text-[22px] leading-none font-medium text-ink">
            {metric.value.toFixed(metric.precision)}
            {metric.unit && (
              <span className="ml-1 text-[14px] font-normal text-ink-secondary">{metric.unit}</span>
            )}
          </span>
          {/* Same slot widths as a supporting row, so the change column runs
              straight down the whole table. */}
          {previous !== undefined && (
            <>
              <span aria-hidden="true" className="w-3 shrink-0" />
              <Change text={change} />
            </>
          )}
        </div>
      </div>
      {floors.length > 0 && (
        /* Printed at the primary's precision, because the comparison is the
           reason they are here. No arrow on any of them: a floor is a property
           of the dataset, so there is no direction the submission controls. */
        <dl className="mt-1.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {floors.map((floor) => (
            <div key={floor.key} className="flex items-baseline gap-1.5">
              <dt className="text-[13px] text-ink-faint">{floor.label}</dt>
              <dd className="u-tnum font-mono text-[12.5px] text-ink-secondary">
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
        <dl className="mt-3 max-w-[60ch] space-y-1.5">
          {floors
            .filter((floor) => floor.help)
            .map((floor) => (
              <div key={floor.key}>
                <dt className="inline text-[13px] font-semibold text-ink-secondary">{floor.label}. </dt>
                <dd className="inline font-serif text-[14px] leading-[1.55] text-ink-secondary">
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
        <p className="mt-2.5 max-w-[60ch] font-serif text-[14px] leading-[1.55] text-ink-secondary">
          {metric.help}
        </p>
      )}
    </figure>
  );
}

/**
 * The list's job is scanning: label on the left, value on the right, aligned
 * down the column. An always-open explanation would destroy that, and a
 * tooltip would fail on touch and hide two sentences behind a hover. So the
 * row expands in place, the way a marginal note unfolds in a notebook.
 *
 * The whole row is the button. No help icon: an icon on every row would add
 * eleven pieces of furniture to a list whose value is its quietness, and a
 * row-sized hit target is easier to hit than a 16px glyph. The affordance is
 * a dotted underline on the label, the printer's convention for an annotated
 * term, which appears only on rows that actually carry an explanation.
 *
 * The right-hand cluster keeps fixed slots (value, direction, change) so the
 * values stay one column even when a row carries a floor or a "not scored"
 * tag and its neighbor does not.
 */
function SupportingMetricRow({
  metric,
  floors = [],
  subordinate = false,
  rolesRecorded,
  previous,
  compared,
}: {
  metric: Metric;
  /** Rendered as this metric's scale rather than as rows of their own. A
   *  metric can declare more than one: week 1 publishes a chance baseline and
   *  a trivial baseline against the same score, and reading them together is
   *  the point of having both. */
  floors?: Metric[];
  /** A probe reported beside the score it shadows, indented under it. */
  subordinate?: boolean;
  /** Whether this run recorded any metric roles. See `claimsDirection`. */
  rolesRecorded: boolean;
  previous?: Metric;
  /** Whether the table has a change column at all. */
  compared: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const explained = Boolean(metric.help);
  // A floor is a fact about the dataset; a change in it is a change of
  // benchmark data, not of the team's code, so it gets no change mark.
  const change = metric.role === "floor" ? null : formatChange(metric, previous);

  const value = (
    <dd className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2.5 gap-y-0.5">
      {/* The scale the number sits on, not a reading of its own. A floor was
          its own row with an arrow saying "higher is better", which is advice
          to raise a number the submission does not control, and it left the
          comparison the floor exists for as manual work. One floor is just
          "floor"; two need their own names, because "floor" cannot tell them
          apart. */}
      {floors.map((floor) => (
        <span key={floor.key} className="u-tnum font-mono text-[12px] text-ink-faint">
          {floors.length === 1 ? "floor" : floor.label.toLowerCase()}{" "}
          {formatMetricValue({ ...floor, precision: metric.precision })}
        </span>
      ))}
      {/* Not scored and which way is better are separate facts, so they are
          separate marks rather than two branches of one choice. */}
      {metric.role === "reported" && (
        <span className="text-[12px] text-ink-faint italic">not scored</span>
      )}
      <span className="flex items-baseline">
        <span className="u-tnum font-mono text-[13.5px] font-medium text-ink">
          {formatMetricValue(metric)}
        </span>
        <span className="ml-2 inline-flex w-3 shrink-0 items-center self-center text-ink-faint">
          {claimsDirection(metric, rolesRecorded) && (
            <>
              <DirectionArrow higherIsBetter={metric.higherIsBetter} size={10} />
              <span className="sr-only">{directionLabel(metric)}</span>
            </>
          )}
        </span>
        {compared && <span className="ml-2.5"><Change text={change} /></span>}
      </span>
    </dd>
  );

  // Indented and quieter, so the eye reads it as belonging to the row above
  // rather than as another result.
  const rowPadding = subordinate ? "py-1.5 pl-5" : "py-2.5";
  const labelClass = subordinate ? "text-[13px] text-ink-faint" : "text-[14px] text-ink-secondary";

  if (!explained) {
    return (
      <div
        className={`flex items-baseline justify-between gap-4 border-b border-rule-soft ${rowPadding}`}
      >
        <dt className={`min-w-0 ${labelClass}`}>{metric.label}</dt>
        {value}
      </div>
    );
  }

  return (
    <div className="border-b border-rule-soft">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`group relative flex w-full items-baseline justify-between gap-4 text-left transition-colors duration-150 hover:bg-ink/[0.03] focus-visible:outline-offset-[-2px] ${rowPadding}`}
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
        {/* mr-auto, because the brackets' wrapper is an empty flex item too:
            with justify-between alone the label floated to the middle. */}
        <dt
          className={`mr-auto min-w-0 underline decoration-rule-strong decoration-dotted underline-offset-[3px] group-hover:text-ink ${labelClass}`}
        >
          {metric.label}
        </dt>
        {value}
      </button>
      {/* Opens at once and fades in; `hidden` keeps the closed note out of
          the accessibility tree and the tab order. */}
      <div id={panelId} hidden={!open} className="anim-reveal">
          <p className="mb-2.5 max-w-[56ch] border-l border-detect/30 pl-3 font-serif text-[14px] leading-[1.55] text-ink-secondary">
            {metric.help}
          </p>
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
export function SupportingMetrics({
  metrics,
  rolesRecorded = true,
  previous = null,
}: {
  metrics: Metric[];
  /** Whether this run recorded any metric roles. See `claimsDirection`. */
  rolesRecorded?: boolean;
  /** Every metric of the run this one is compared against. Null for none,
   *  which also drops the change column. */
  previous?: Metric[] | null;
}) {
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
  // Diagnostics last, under their own label, because they describe one
  // component in more detail rather than answering "how did I do". A
  // benchmark that declares no roles keeps its original order, since every
  // metric sorts equally.
  const main = rows.filter((metric) => metric.role !== "diagnostic");
  const diagnostics = rows.filter((metric) => metric.role === "diagnostic");
  const before = previous ? new Map(previous.map((metric) => [metric.key, metric])) : null;

  const list = (group: Metric[]) => (
    <dl>
      {group.map((metric) => (
        <div key={metric.key}>
          <SupportingMetricRow
            metric={metric}
            floors={floors.get(metric.key)}
            rolesRecorded={rolesRecorded}
            previous={before?.get(metric.key)}
            compared={before !== null}
          />
          {(reported.get(metric.key) ?? []).map((probe) => (
            <SupportingMetricRow
              key={probe.key}
              metric={probe}
              subordinate
              rolesRecorded={rolesRecorded}
              previous={before?.get(probe.key)}
              compared={before !== null}
            />
          ))}
        </div>
      ))}
    </dl>
  );

  return (
    <div>
      {main.length > 0 && list(main)}
      {diagnostics.length > 0 && (
        <div className={main.length > 0 ? "mt-6" : undefined}>
          <p className="u-label">Diagnostics</p>
          <p className="mt-0.5 mb-1 text-[13px] text-ink-faint">
            These look at one part of the pipeline more closely.
          </p>
          {list(diagnostics)}
        </div>
      )}
    </div>
  );
}
