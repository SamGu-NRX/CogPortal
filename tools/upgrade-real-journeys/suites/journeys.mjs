// STAGE 2 — migration + existing-user journeys. Fill in (owner: journeys sub-thread).
// Objective: restore state/beta-snapshot/, apply alpha's migrations in the
// order deployment would (wrangler d1 migrations apply against the alpha
// checkout), build + start alpha's Worker and SPA (lib/servers.mjs), then with
// Playwright drive every existing user's journey: sign-in, dashboard, team,
// run pages, history, leaderboard (signed out too), staff, admin. Each journey
// must show the user's existing data truthfully — nothing lost, duplicated or
// misattributed (assert against the snapshot's own rows via lib/d1.mjs).
// Pass bar: receipts/journeys.json has a result per journey and per user role;
// zero retries; flakes are failures.
export async function run() {
  throw new Error("journeys stage not implemented yet (journeys sub-thread)");
}
process.argv[1]?.endsWith("journeys.mjs") && run().catch((e) => { console.error(e); process.exit(1); });
