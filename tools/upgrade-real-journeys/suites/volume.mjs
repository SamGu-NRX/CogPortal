// STAGE 5 — course-volume measurement. Fill in (owner: volume sub-thread).
// Objective: scale the beta snapshot to course size with generated test
// accounts only (e.g. three cohorts x 40 teams, every week, hundreds of runs
// per team — lib/scale.mjs), then record D1 queries per request and CPU time
// for EVERY route alpha serves, using the instrumented shim (lib/measure.mjs).
// Flag each route over 50 queries per invocation or 10 ms CPU, with the exact
// request that shows it. Routes over the limits are Worker defects: witness
// them here, hand to the web e2e task.
// Honesty rules (plan: pstack benchmark checklist): document the measurement
// method and its limits, keep the raw per-request rows, never invent a number,
// and label what CPU metric workerd actually reported. If a number cannot be
// measured locally, record it as unmeasured with the reason — never estimate.
// Pass bar: receipts/volume.md covers every route; zero unflagged over-limit
// routes.
export async function run() {
  throw new Error("volume stage not implemented yet (volume sub-thread)");
}
process.argv[1]?.endsWith("volume.mjs") && run().catch((e) => { console.error(e); process.exit(1); });
