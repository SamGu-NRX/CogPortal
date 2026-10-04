import type { PublicSweep } from "@cogworks/contracts/schema";

/**
 * Which stored curves the public board may draw, and what it calls them.
 *
 * A run's `sweep_json` was written for the team's own run page. Its axis,
 * metric and point labels are strings the runner copied from the benchmark
 * plugin, and nothing proves that every string a future plugin writes there
 * is fit to publish. So the board never forwards them. A curve is public only
 * when the run's benchmark id, version and scorer match a spec here; the
 * stored strings are compared against the spec as an identity check, and
 * everything emitted as text comes from the spec. Points are the only stored
 * values that leave, and only as finite numbers.
 *
 * No spec, no curve. That is deliberate for the benchmarks below:
 *
 * - Audio (week1 at 4e516f3) plots its per-size `top1` against library size
 *   but declares no `sweep_metric`, so the runner labels the curve with the
 *   aggregate `identification_score`. Publishing that label could name the
 *   wrong measure, and nothing checked here proves the two are the same.
 * - Vision (week2 at a3dd948) declares no sweep.
 */
type PublicSweepSpec = {
  benchmarkId: string;
  benchmarkVersion: number;
  scorerVersion: string;
  /** What the runner stores for this benchmark. Checked, never emitted. */
  stored: { axis: string; metric: string };
  /** The run must have published this metric, or the curve is withheld. */
  publishedMetricKey: string;
  axis: string;
  metric: string;
  /**
   * Every x the benchmark can produce, in order. `label` is the public name;
   * `stored` is the producer's identifier for that x, checked against a
   * stored point's label and never emitted.
   */
  ticks: ReadonlyArray<{ x: number; label: string; stored: string }>;
  /** How the curve relates to the scored number, when a reader can't guess. */
  note: string | null;
};

const PUBLIC_SWEEP_SPECS: readonly PublicSweepSpec[] = [
  {
    // benchmarks/week3 at 4b17554, language_search_benchmark/plugins.py:
    // sweep_axis_label, sweep_metric, sweep_x_key "rung_index" and
    // sweep_label_key "rung" (lines 477-485), filled by `_rung_curve` from
    // perturb.RUNGS (perturb.py line 81). scripts/validate_week3_submodule.py
    // fails CI if the plugin stops saying so.
    benchmarkId: "language-search",
    benchmarkVersion: 1,
    scorerVersion: "retrieval-v4",
    stored: { axis: "how far the query is from the caption", metric: "search_mrr" },
    publishedMetricKey: "search_mrr",
    // The four rewrites are kinds of query, not points on a measured scale,
    // so the axis names the variant rather than a distance.
    axis: "query variant",
    metric: "Search MRR",
    // Public names follow the plugin's own metric labels for these rungs
    // ("Search MRR, keywords only" and so on, plugins.py metric_labels);
    // `stored` is perturb.RUNGS.
    ticks: [
      { x: 0, label: "caption unchanged", stored: "verbatim" },
      { x: 1, label: "keywords only", stored: "keywords" },
      { x: 2, label: "first three words", stored: "truncated" },
      { x: 3, label: "one typo", stored: "typo" },
    ],
    // The curve's first point is not in the score, and the drawing can't
    // say so. plugins.py metric_help["search_mrr"] (lines 270-281): an
    // average over the three rewrites; "the caption unchanged is run and
    // reported beside them, not scored". metric_roles (394-411) agrees.
    note: "Caption unchanged is reported, not scored; the scored Search MRR averages the other three variants.",
  },
];

/** The runner protocol's bounds (packages/contracts/src/protocol.ts SweepSchema). */
const MIN_POINTS = 2;
const MAX_POINTS = 24;

/**
 * The public curve for one published run, or null.
 *
 * Null covers every way the stored curve can be unusable: no spec for this
 * benchmark and scorer, unparseable JSON, a different axis or metric than the
 * spec expects, too few or too many points, a value that is not a finite
 * number, y outside 0..1, x out of order, an x the benchmark cannot produce,
 * a stored label that disagrees with the spec's name for that x, or a run
 * that never published the curve's metric. It never throws, so one team's
 * malformed run costs that run its curve and nothing else on the board.
 */
export function projectPublicSweep(
  run: { benchmarkId: string; benchmarkVersion: number; scorerVersion: string; sweepJson: string | null },
  publishedMetricKeys: ReadonlySet<string>,
): PublicSweep | null {
  const spec = PUBLIC_SWEEP_SPECS.find(
    (candidate) =>
      candidate.benchmarkId === run.benchmarkId &&
      candidate.benchmarkVersion === run.benchmarkVersion &&
      candidate.scorerVersion === run.scorerVersion,
  );
  if (!spec || !run.sweepJson) return null;
  if (!publishedMetricKeys.has(spec.publishedMetricKey)) return null;

  let stored: unknown;
  try {
    stored = JSON.parse(run.sweepJson);
  } catch {
    return null;
  }
  if (!isRecord(stored)) return null;
  if (stored.axis !== spec.stored.axis || stored.metric !== spec.stored.metric) return null;
  if (!Array.isArray(stored.points)) return null;
  if (stored.points.length < MIN_POINTS || stored.points.length > MAX_POINTS) return null;

  const storedNames = new Map(spec.ticks.map((tick) => [tick.x, tick.stored]));
  const points: PublicSweep["points"] = [];
  for (const point of stored.points) {
    if (!isRecord(point)) return null;
    const { x, y, label } = point;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || y < 0 || y > 1) return null;
    if (!storedNames.has(x)) return null;
    if (label !== undefined && label !== storedNames.get(x)) return null;
    const previous = points[points.length - 1];
    if (previous && x <= previous.x) return null;
    points.push({ x, y });
  }

  return {
    axis: spec.axis,
    metric: spec.metric,
    ticks: spec.ticks.map((tick) => ({ x: tick.x, label: tick.label })),
    points,
    note: spec.note,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
