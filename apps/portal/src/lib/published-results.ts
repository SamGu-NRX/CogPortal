import type {
  Benchmark,
  FamilyLeaderboard,
  LeaderboardEntry,
  Metric,
  MetricRole,
  PublicSweep,
} from "@cogworks/contracts/schema";

/**
 * The public board's reading order: the most recently completed result first.
 *
 * `docs/design/the-instrument-not-the-judge.md` (lines 90-95) turns the
 * leaderboard into a recency-ordered gallery, so the page does not keep the
 * read model's order, which is by the ranked measure and reads as a ranking
 * with or without a rank column. The API keeps its order and `rank` for
 * anything that reads `/v1/leaderboard`; only the page reorders.
 *
 * Ties fall back to the team name and then the commit, compared by code unit
 * rather than locale, so two results finished in the same millisecond land in
 * the same order on every browser and every refetch.
 */
export function newestFirst(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort(
    (left, right) =>
      right.completedAt - left.completedAt ||
      compareCodeUnits(left.teamName, right.teamName) ||
      compareCodeUnits(left.sha, right.sha),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type RoleGroup = {
  /** `null` collects metrics whose run recorded no role for them. */
  role: MetricRole | null;
  label: string;
  metrics: Metric[];
};

/**
 * What each group is called on the public board, in the order it appears.
 *
 * A metric with no recorded role is not presumed scored. Runs stored before
 * the portal kept roles (migration 0035) cannot say which of their numbers
 * were floors, so their numbers go under a label that says exactly that.
 */
const ROLE_GROUPS: ReadonlyArray<{ role: MetricRole | null; label: string }> = [
  { role: "scored", label: "Part of the score" },
  { role: "reported", label: "Measured, not scored" },
  { role: "plotted", label: "Plotted values" },
  { role: "floor", label: "Floors set by the data" },
  { role: "diagnostic", label: "Diagnostics" },
  { role: null, label: "Role not recorded" },
];

/**
 * Supporting measurements grouped by the role the benchmark gave them.
 *
 * Every metric lands in exactly one group, and within a group they keep the
 * order the read model sent. Empty groups are omitted.
 */
export function groupMetricsByRole(metrics: readonly Metric[]): RoleGroup[] {
  return ROLE_GROUPS.map(({ role, label }) => ({
    role,
    label,
    metrics: metrics.filter((metric) => (metric.role ?? null) === role),
  })).filter((group) => group.metrics.length > 0);
}

/** The mono line naming exactly which results this board compares. */
export function benchmarkScopeLine(benchmark: Pick<Benchmark, "id" | "version" | "scorerVersion">): string {
  return `${benchmark.id} v${benchmark.version} · scorer ${benchmark.scorerVersion} · newest first`;
}

export function familyScopeLine(family: FamilyLeaderboard["family"]): string {
  // A missing scorer is said to be unknown rather than left out, so the line
  // never reads as if the identity were checked.
  const parts = family.components
    .map(
      (component) =>
        `${component.benchmarkId} v${component.benchmarkVersion} (scorer ${component.scorerVersion ?? "unknown"})`,
    )
    .filter((part, index, all) => all.indexOf(part) === index);
  return `${family.id} v${family.version} · from ${parts.join(" + ")} · newest first`;
}

/**
 * One sentence on what the family's score is made of, built from its
 * components rather than written for one family, so a change of weights in
 * the catalog changes the sentence too.
 */
export function familyMakeup(family: FamilyLeaderboard["family"]): string {
  const { components } = family;
  if (components.length === 0) return "";
  const labels = components.map((component) => component.label);
  const named =
    labels.length === 1
      ? labels[0]!
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const equal = components.every((component) => component.weight === components[0]!.weight);
  if (equal) {
    return components.length === 1 ? `${family.title} is ${named}.` : `${family.title} weights ${named} equally.`;
  }
  const total = components.reduce((sum, component) => sum + component.weight, 0);
  const shares = components
    .map((component) => `${component.label} ${Math.round((component.weight / total) * 100)}%`)
    .join(", ");
  return `${family.title} combines ${shares}.`;
}

/**
 * The one sentence printed over a published curve: its lowest and highest
 * reading and where each was taken, then any position the curve has no point
 * for. Measurements only. The benchmark's own sentence about why a curve has
 * its shape is written about the team's code and stays on the team's run
 * page, and Week 3's x positions are kinds of query rather than amounts, so
 * nothing here calls a step a fall or a knee.
 */
export function readPublicSweep(sweep: PublicSweep): string {
  const name = (x: number) => sweep.ticks.find((tick) => tick.x === x)?.label ?? String(x);
  const lead = `${sweep.metric} by ${sweep.axis}`;
  const [first, ...rest] = sweep.points;
  if (!first) return lead;
  let low = first;
  let high = first;
  for (const point of rest) {
    if (point.y < low.y) low = point;
    if (point.y > high.y) high = point;
  }
  const reading =
    low.y.toFixed(2) === high.y.toFixed(2)
      ? `${lead}: ${high.y.toFixed(2)} at every point measured.`
      : `${lead}: lowest ${low.y.toFixed(2)} (${name(low.x)}), highest ${high.y.toFixed(2)} (${name(high.x)}).`;
  const measured = new Set(sweep.points.map((point) => point.x));
  const missing = sweep.ticks.filter((tick) => !measured.has(tick.x)).map((tick) => tick.label);
  // "No curve point", not "not measured": the run may have published that
  // variant's number elsewhere, and the curve's gap is all this can see.
  return missing.length > 0 ? `${reading} No curve point for ${missing.join(", ")}.` : reading;
}
