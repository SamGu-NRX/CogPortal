/**
 * How a live run's team-scoped surface is recognized in `/api/run-surfaces`.
 *
 * The run-surface snapshot does not serialize the local report id: its
 * local-stage fields are `localRunId` (the announced session), `sha`, `stage`,
 * `status`, and `metrics` (read from the synced report through the session's
 * `report_id`). A check that greps the snapshot for the report id can never
 * pass, so the surface for THIS run is bound by what the schema does promise:
 * local stage, this benchmark, the run's pinned commit, and the report's own
 * primary metric value.
 */

/** The fields of a run's report that identify its surface. */
export interface LiveRunIdentity {
  benchmarkId: string;
  /** The commit the run pinned (`repo.head()` at run time). */
  sha: string;
}

/**
 * The one team surface that belongs to this run: local-stage, for the run's
 * benchmark, announced from the run's commit, with a session attached.
 */
export function findLiveRunSurface(surfaces: readonly any[], run: LiveRunIdentity): any | undefined {
  return surfaces.find(
    (row) =>
      row?.stage === "local" &&
      row?.benchmark?.id === run.benchmarkId &&
      row?.sha === run.sha &&
      row?.localRunId != null,
  );
}

/** The primary metric of a report's or a snapshot's metrics array. */
export function primaryMetricOf(metrics: readonly any[] | null | undefined): { key: string; value: number } | undefined {
  const primary = (metrics ?? []).find((metric) => metric?.primary === true);
  if (!primary || typeof primary.key !== "string") return undefined;
  return { key: primary.key, value: Number(primary.value) };
}

/** Whether the surfaced metric is the reported one: same key, same value
 * (bit-equal in practice — the snapshot re-serves the report's stored
 * metrics — with a relative tolerance so a float round-trip cannot flake). */
export function sameMetric(
  reported: { key: string; value: number } | undefined,
  surfaced: { key: string; value: number } | undefined,
): boolean {
  if (!reported || !surfaced) return false;
  if (reported.key !== surfaced.key) return false;
  const scale = Math.max(Math.abs(reported.value), Math.abs(surfaced.value), 1e-12);
  return Math.abs(reported.value - surfaced.value) <= scale * 1e-9;
}
