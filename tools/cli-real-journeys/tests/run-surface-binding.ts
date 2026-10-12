/**
 * The live-run surface binding (review follow-up: "the run surfaces a
 * team-scoped live-run entry").
 *
 * The portal's run-surface snapshot never serializes the local report id —
 * its local-stage fields are localRunId, sha, stage, status, and the synced
 * report's metrics (read through the session's report_id). The reviewed check
 * grepped the snapshot for the report id and could never pass. The binding
 * now matches what the schema promises and closes the loop on the report's
 * own primary metric.
 *
 * Demonstrated against the real snapshot shape (fields as the portal's
 * RunSurfaceSnapshotSchema serializes them):
 *   - a report id appears nowhere in the snapshot JSON, so the old
 *     report-id grep cannot bind any surface;
 *   - findLiveRunSurface binds this run's surface by stage, benchmark, the
 *     pinned commit, and an attached session — and rejects foreign surfaces
 *     (hosted stage, another commit, no session);
 *   - the surfaced primary metric equals the report's (same key and value)
 *     and differs from a foreign report's.
 *
 * Run: npx tsx tests/run-surface-binding.ts  (no network, no stack)
 */

import { findLiveRunSurface, primaryMetricOf, sameMetric } from "../support/surface-binding.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// The shape the portal actually served in a live run (fields trimmed to what
// the binding reads; no report id exists on the snapshot).
const liveSnapshot = {
  id: "surface_430aa50a8d35d26f4a9b",
  benchmark: { id: "language-search", version: 1, title: "Language search" },
  sha: "d5ca69230422ee7e449ca2b72ae9cc3c3ce2909e",
  stage: "local",
  status: "succeeded",
  localRunId: "localrun_8bdc312699f9430aa50a8d35d26f4a9b",
  metrics: [
    { key: "overall", label: "Overall", value: 0.34872834217861515, primary: true },
    { key: "text_mrr", label: "Text MRR", value: 0.677090733361776, primary: false },
  ],
};

// The synced report the run saved locally (the report file the journey reads).
const reportMetrics = [
  { key: "overall", label: "Overall", value: 0.34872834217861515, primary: true },
  { key: "text_mrr", label: "Text MRR", value: 0.677090733361776, primary: false },
];
const reportId = "local_1934ef6856a34c9b96dbd4626ec2dc34";

// 1. The reviewed premise is impossible: the report id is not in the snapshot.
check(
  "the snapshot JSON nowhere carries the local report id",
  !JSON.stringify(liveSnapshot).includes(reportId),
);

// 2. The old binding (grep for the report id) would find nothing.
const oldBinding = [liveSnapshot].find((row) => JSON.stringify(row).includes(reportId));
check("the old report-id binding matches no surface", oldBinding === undefined);

// 3. The corrected binding finds this run's surface by its own fields.
const surface = findLiveRunSurface([liveSnapshot], {
  benchmarkId: "language-search",
  sha: "d5ca69230422ee7e449ca2b72ae9cc3c3ce2909e",
});
check("the binding finds this run's surface", surface === liveSnapshot);

// 4. Foreign surfaces are rejected: hosted stage, another commit, no session.
const foreign: any[] = [
  { ...liveSnapshot, stage: "hosted", localRunId: null },
  { ...liveSnapshot, sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { ...liveSnapshot, localRunId: null },
  { ...liveSnapshot, benchmark: { ...liveSnapshot.benchmark, id: "vision-recognition" } },
];
for (const row of foreign) {
  check(
    `the binding rejects a foreign surface (stage=${row.stage ?? "local"} sha=${row.sha.slice(0, 7)} localRunId=${row.localRunId ?? "null"} benchmark=${row.benchmark.id})`,
    findLiveRunSurface([row], {
      benchmarkId: "language-search",
      sha: "d5ca69230422ee7e449ca2b72ae9cc3c3ce2909e",
    }) === undefined,
  );
}

// 5. The metrics loop-closure: the surfaced primary metric is the report's.
const reported = primaryMetricOf(reportMetrics);
const surfaced = primaryMetricOf(liveSnapshot.metrics);
check(
  "the surfaced primary metric equals the reported one",
  sameMetric(reported, surfaced) && reported !== undefined && reported.key === "overall",
);
check(
  "a different report's primary metric does not bind",
  !sameMetric(reported, { key: "overall", value: 0.9 }) &&
    !sameMetric(reported, { key: "identification_score", value: 0.34872834217861515 }),
);
check(
  "missing metrics on either side never bind",
  !sameMetric(reported, undefined) && !sameMetric(undefined, surfaced) && !sameMetric(undefined, undefined),
);
check(
  "a metrics array without a primary entry yields no primary metric",
  primaryMetricOf([{ key: "overall", value: 1, primary: false }]) === undefined &&
    primaryMetricOf(null) === undefined &&
    primaryMetricOf(undefined) === undefined,
);

if (failures > 0) {
  console.error(`run-surface-binding: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("run-surface-binding: all checks passed");
}
