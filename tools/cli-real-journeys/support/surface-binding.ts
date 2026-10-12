/**
 * How a live run's team-scoped surface is recognized in `/api/run-surfaces`.
 *
 * The snapshot does not serialize the local report id. Its local-stage fields
 * are `localRunId` (the live session), `sha`, `stage`, `status` and `metrics`
 * (read from the synced report through the session's `report_id`). The CLI
 * does not print its session id either, but it names it on the wire: every
 * progress event goes to `POST /api/v1/local-runs/<sessionId>/events` (or
 * `/events/batch`) through the shaper, which records each request line. The
 * surface for THIS run is the one whose `localRunId` is that session, at this
 * benchmark and commit, in a terminal `succeeded` state.
 */

/** What identifies this run's surface. */
export interface LiveRunIdentity {
  benchmarkId: string;
  /** The commit the run pinned (`repo.head()` at run time). */
  sha: string;
  /** The session id the CLI posted its events under during this run. */
  sessionId: string;
}

/** One request line the shaper recorded in front of the portal Worker. */
export interface ShapedRequest {
  seq: number;
  method: string;
  path: string;
}

const SESSION_EVENT_PATH = /^\/api\/v1\/local-runs\/([^/?]+)\/events(?:\/batch)?(?:\?.*)?$/;

/**
 * The live session ids the CLI posted events under in a window of shaper
 * request lines. A single live run yields exactly one; the caller asserts it.
 */
export function liveSessionIds(requests: readonly ShapedRequest[]): string[] {
  const ids = new Set<string>();
  for (const request of requests) {
    if (request.method !== "POST") continue;
    const match = request.path.match(SESSION_EVENT_PATH);
    if (match) ids.add(decodeURIComponent(match[1]));
  }
  return [...ids];
}

/** Why a surface is not this run's, or null when it is. */
export function surfaceMismatch(row: any, run: LiveRunIdentity): string | null {
  if (row?.localRunId !== run.sessionId) return `localRunId ${row?.localRunId ?? "null"} is not this run's session ${run.sessionId}`;
  if (row?.stage !== "local") return `stage ${row?.stage} is not local`;
  if (row?.benchmark?.id !== run.benchmarkId) return `benchmark ${row?.benchmark?.id} is not ${run.benchmarkId}`;
  if (row?.sha !== run.sha) return `sha ${row?.sha} is not the run's commit ${run.sha}`;
  if (row?.status !== "succeeded") return `status ${row?.status} is not succeeded`;
  return null;
}

/** This run's surface: its own session, local stage, benchmark and commit,
 * finished with `succeeded`. */
export function findLiveRunSurface(surfaces: readonly any[], run: LiveRunIdentity): any | undefined {
  return surfaces.find((row) => surfaceMismatch(row, run) === null);
}

/** The primary metric of a report's or a snapshot's metrics array. */
export function primaryMetricOf(metrics: readonly any[] | null | undefined): { key: string; value: number } | undefined {
  const primary = (metrics ?? []).find((metric) => metric?.primary === true);
  if (!primary || typeof primary.key !== "string") return undefined;
  return { key: primary.key, value: Number(primary.value) };
}

/** Whether the surfaced metric is the reported one: same key, same value
 * (bit-equal in practice, since the snapshot re-serves the report's stored
 * metrics, with a relative tolerance so a float round-trip cannot flake). */
export function sameMetric(
  reported: { key: string; value: number } | undefined,
  surfaced: { key: string; value: number } | undefined,
): boolean {
  if (!reported || !surfaced) return false;
  if (reported.key !== surfaced.key) return false;
  const scale = Math.max(Math.abs(reported.value), Math.abs(surfaced.value), 1e-12);
  return Math.abs(reported.value - surfaced.value) <= scale * 1e-9;
}
