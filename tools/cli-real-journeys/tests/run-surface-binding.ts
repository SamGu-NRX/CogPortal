/**
 * The live-run surface binding.
 *
 * The run-surface snapshot never serializes the local report id; its
 * local-stage fields are localRunId (the live session), sha, stage, status,
 * and the synced report's metrics. The binding takes the session id from the
 * CLI's own event posts (the shaper's request lines) and requires the surface
 * to be that session's, at this benchmark and commit, finished `succeeded`.
 *
 * Before this fix (c722ed79) the binding matched any surface with some
 * localRunId at the same benchmark and commit, and the journey compared only
 * the primary metric. So another session at the same commit with the same
 * score, or a session still running with stored metrics, passed. Those are
 * the counterexamples below; the pre-fix predicate is replayed inline to show
 * it accepted them.
 *
 * Run: npx tsx tests/run-surface-binding.ts  (no network, no stack)
 */

import {
  findLiveRunSurface,
  liveSessionIds,
  primaryMetricOf,
  sameMetric,
  surfaceMismatch,
  type ShapedRequest,
} from "../support/surface-binding.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** The pre-fix predicate (support/surface-binding.ts:24-30 at c722ed79). */
function preFixBinding(surfaces: readonly any[], run: { benchmarkId: string; sha: string }): any | undefined {
  return surfaces.find(
    (row) => row?.stage === "local" && row?.benchmark?.id === run.benchmarkId && row?.sha === run.sha && row?.localRunId != null,
  );
}

const SESSION = "localrun_8bdc312699f9430aa50a8d35d26f4a9b";
const SHA = "d5ca69230422ee7e449ca2b72ae9cc3c3ce2909e";

// The snapshot shape the portal served in a live run (trimmed to the fields
// the binding reads).
const liveSnapshot = {
  id: "surface_430aa50a8d35d26f4a9b",
  benchmark: { id: "language-search", version: 1, title: "Language search" },
  sha: SHA,
  stage: "local",
  status: "succeeded",
  localRunId: SESSION,
  metrics: [
    { key: "overall", label: "Overall", value: 0.34872834217861515, primary: true },
    { key: "text_mrr", label: "Text MRR", value: 0.677090733361776, primary: false },
  ],
};
const reportMetrics = liveSnapshot.metrics.map((metric) => ({ ...metric }));
const identity = { benchmarkId: "language-search", sha: SHA, sessionId: SESSION };

// 1. The session id comes from the CLI's own event posts.
const requests: ShapedRequest[] = [
  { seq: 10, method: "POST", path: "/api/v1/local-runs" },
  { seq: 11, method: "POST", path: `/api/v1/local-runs/${SESSION}/events` },
  { seq: 12, method: "GET", path: "/api/v1/benchmarks" },
  { seq: 13, method: "POST", path: `/api/v1/local-runs/${SESSION}/events/batch` },
];
check("the CLI's event posts name exactly one session", JSON.stringify(liveSessionIds(requests)) === JSON.stringify([SESSION]));
check(
  "two sessions in one window are both reported, so the journey's one-session check fails",
  liveSessionIds([...requests, { seq: 14, method: "POST", path: "/api/v1/local-runs/localrun_other/events" }]).length === 2,
);
check(
  "GET reads and the start request name no session",
  liveSessionIds([
    { seq: 1, method: "POST", path: "/api/v1/local-runs" },
    { seq: 2, method: "GET", path: `/api/v1/local-runs/${SESSION}/events` },
  ]).length === 0,
);

// 2. This run's own surface binds.
check("the binding finds this session's surface", findLiveRunSurface([liveSnapshot], identity) === liveSnapshot);

// 3. Counterexamples the pre-fix predicate accepted, now rejected.
const sameCommitOtherSession = { ...liveSnapshot, id: "surface_other", localRunId: "localrun_00000000000000000000000000000000" };
const stillRunning = { ...liveSnapshot, status: "running" };
const failedRun = { ...liveSnapshot, status: "failed" };
for (const [label, row] of [
  ["another session at the same commit with the same score", sameCommitOtherSession],
  ["this session still running with stored metrics", stillRunning],
  ["this session failed", failedRun],
] as const) {
  check(`red: the pre-fix predicate accepted ${label}`, preFixBinding([row], identity) === row);
  check(`green: the binding rejects ${label}`, findLiveRunSurface([row], identity) === undefined, surfaceMismatch(row, identity) ?? "matched");
}
check(
  "the other session's surface carries the same primary metric, so the metric check alone could not tell them apart",
  sameMetric(primaryMetricOf(reportMetrics), primaryMetricOf(sameCommitOtherSession.metrics)),
);
check(
  "listed first, the other session's surface is skipped and this run's is found",
  findLiveRunSurface([sameCommitOtherSession, stillRunning, liveSnapshot], identity) === liveSnapshot,
);

// 4. The rest of the identity still binds.
for (const row of [
  { ...liveSnapshot, stage: "hosted" },
  { ...liveSnapshot, sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { ...liveSnapshot, localRunId: null },
  { ...liveSnapshot, benchmark: { ...liveSnapshot.benchmark, id: "vision-recognition" } },
]) {
  check(`the binding rejects: ${surfaceMismatch(row, identity)}`, findLiveRunSurface([row], identity) === undefined);
}

// 5. The metric loop-closure.
check("the surfaced primary metric equals the reported one", sameMetric(primaryMetricOf(reportMetrics), primaryMetricOf(liveSnapshot.metrics)));
check(
  "a different value or key does not match",
  !sameMetric(primaryMetricOf(reportMetrics), { key: "overall", value: 0.9 }) &&
    !sameMetric(primaryMetricOf(reportMetrics), { key: "identification_score", value: 0.34872834217861515 }),
);
check(
  "missing metrics never match",
  !sameMetric(primaryMetricOf(reportMetrics), undefined) && !sameMetric(undefined, undefined) && primaryMetricOf(null) === undefined,
);

if (failures > 0) {
  console.error(`run-surface-binding: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("run-surface-binding: all checks passed");
}
