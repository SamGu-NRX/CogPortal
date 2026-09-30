import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const LOCAL_SEED = join(MIGRATIONS, "..", "scripts", "seed-local.sql");
const DEMO_TABLES = ["teams", "runs", "run_phases", "run_metrics", "official_attempts", "leaderboard_selections"];

// Hosted dev and production both recorded exactly these names in d1_migrations
// (read-only query, 2026-09-22). Wrangler matches by filename, so renaming one
// would run its SQL a second time there.
const HOSTED_LEDGER = [
  "0001_init", "0002_seed", "0003_github", "0004_team_mgmt", "0005_platform",
  "0006_template_source_name", "0007_cohort_roles", "0008_team_tas", "0009_discord_live_runs",
  "0010_run_surfaces", "0011_one_team_per_user", "0012_setup_verifications", "0013_week2_vision",
  "0014_better_auth", "0015_active_run_unique", "0016_backfill_github_accounts",
  "0017_auth_hardening", "0018_week3_language", "0019_run_diagnostics", "0020_week1_audio",
  "0021_metric_help", "0022_team_nudges", "0023_run_sweep", "0024_process_signals",
  "0025_week3_scorer_v2", "0026_week2_clustering_v2", "0027_run_wiring", "0028_run_refusal",
  "0029_refund_ledger", "0030_week3_scorer_v3", "0031_platform_staff", "0032_week3_scorer_v4",
  "0033_weight_artifacts", "0034_team_provenance", "0035_metric_roles",
  "0036_setup_benchmark_scope", "0037_audio_metric_roles", "0038_seed_metric_roles",
  "0039_setup_check_source", "0039_weight_upload_provenance", "0040_remove_refund_cap_index",
  "0040_run_repository_name", "0041_run_retries", "0042_prepared_environment",
  "0043_language_sandbox_contract", "0044_week2_recognition_v2",
].map((name) => `${name}.sql`);

function migrated() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return sqlite;
}

const seed = (sqlite: DatabaseSync) => sqlite.exec(readFileSync(LOCAL_SEED, "utf8"));
const count = (sqlite: DatabaseSync, table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = (sqlite: DatabaseSync) =>
  Object.fromEntries(["cohorts", ...DEMO_TABLES].map((table) =>
    [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()]));

test("every migration the hosted databases recorded keeps its filename", () => {
  const present = new Set(readdirSync(MIGRATIONS));
  assert.deepEqual(HOSTED_LEDGER.filter((name) => !present.has(name)), []);
});

test("migrations alone give a new hosted database no demo rows and no published join code", () => {
  const sqlite = migrated();
  const cohorts = sqlite.prepare("SELECT id, join_code FROM cohorts").all() as { id: string; join_code: string }[];
  assert.equal(cohorts.length, 1);
  assert.equal(cohorts[0].id, "cohort_bwsi26");
  assert.match(cohorts[0].join_code, /^[0-9A-F]{8}$/);
  assert.notEqual(cohorts[0].join_code, "VISION26");
  for (const table of DEMO_TABLES) assert.equal(count(sqlite, table), 0, table);
});

test("the local seed adds the demo cohort code, teams and runs", () => {
  const sqlite = migrated();
  seed(sqlite);
  assert.equal((sqlite.prepare("SELECT join_code FROM cohorts").get() as { join_code: string }).join_code, "VISION26");
  assert.deepEqual(
    Object.fromEntries(DEMO_TABLES.map((table) => [table, count(sqlite, table)])),
    { teams: 6, runs: 9, run_phases: 24, run_metrics: 32, official_attempts: 1, leaderboard_selections: 6 },
  );
  const unscored = sqlite.prepare(
    "SELECT count(*) AS n FROM run_metrics WHERE run_id LIKE 'run_demo_%' AND role IS NOT 'scored'",
  ).get() as { n: number };
  assert.equal(unscored.n, 0);
});

test("a second seed changes nothing and leaves other rows alone", () => {
  const sqlite = migrated();
  seed(sqlite);
  sqlite.exec(`
    INSERT INTO teams (id, cohort_id, name, description, repo_owner, repo_name, repo_full_name, repo_url, default_branch)
    VALUES ('team_other', 'cohort_bwsi26', 'Other Team', NULL, 'other-org', 'other-repo',
            'other-org/other-repo', 'https://github.com/other-org/other-repo', 'main');
    UPDATE teams SET description = 'edited' WHERE id = 'team_demo';
  `);
  const before = snapshot(sqlite);
  seed(sqlite);
  assert.deepEqual(snapshot(sqlite), before);
});
