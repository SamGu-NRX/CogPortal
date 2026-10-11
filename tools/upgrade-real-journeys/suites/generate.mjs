// STAGE 1 — beta state generation. Fill in (owner: state-generation sub-thread).
// Objective: a fresh local D1 with beta's migrations + seed, then realistic
// course state created ONLY through beta's real paths (its own SPA and API as
// dev-auth users, and the 064400e CLI): cohorts, teams, joins and leaves,
// forks, device links, synced local reports from real public week data, hosted
// runs through the fixture provider, published official attempts, staff and TA
// assignments. Snapshot with lib/d1.mjs snapshot() under state/beta-snapshot/.
// Pass bar: `node bin/upgrade-suite.mjs generate` from a fresh clone produces
// the snapshot and a receipt (receipts/generate.json) listing every entity
// class with counts; no real student handles or submissions anywhere.
export async function run() {
  throw new Error("generate stage not implemented yet (state-generation sub-thread)");
}
process.argv[1]?.endsWith("generate.mjs") && run().catch((e) => { console.error(e); process.exit(1); });
