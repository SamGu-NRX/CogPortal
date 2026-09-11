import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Week 2's recognition catalog row after every migration has run.
 *
 * The scorer version is what tells a run page whether two numbers answer the
 * same question, and 0039 moves it because the lifecycle now asks about the
 * people already enrolled on both sides of the stranger's enrollment. This
 * replays the real migration directory into SQLite and reads the row back,
 * rather than matching the file with a pattern: a migration that is present
 * but does not apply, or applies to the wrong row, passes a grep and fails
 * here.
 *
 * It also pins the thing the bump is not allowed to do. `runs.scorer_version`
 * records what actually scored each run, so a v1 result has to stay v1 after
 * a v2 catalog row exists, or the leaderboard would claim numbers were
 * measured under a lifecycle that did not exist when they were taken.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function migrated(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return sqlite;
}

function scorerVersions(sqlite: DatabaseSync): Record<string, string> {
  const rows = sqlite
    .prepare("SELECT id, version, scorer_version FROM benchmarks ORDER BY id, version")
    .all() as Array<{ id: string; version: number; scorer_version: string }>;
  const found: Record<string, string> = {};
  for (const row of rows) {
    found[`${row.id}@${row.version}`] = row.scorer_version;
  }
  return found;
}

test("the recognition catalog row scores as recognition-v2", () => {
  const found = scorerVersions(migrated());

  assert.equal(found["vision-recognition@2"], "recognition-v2");
});

test("the bump moves that row and nothing else", () => {
  const found = scorerVersions(migrated());

  // Clustering shares the Week 2 submodule and its own v2 bump landed in
  // 0026; nothing about this lifecycle change touches it. Week 1 and Week 3
  // are named so a future catalog-wide UPDATE cannot pass this file.
  assert.equal(found["vision-clustering@2"], "clustering-v2");
  assert.equal(found["language-search@1"], "retrieval-v4");
  assert.equal(found["audio-identification@1"], "identification-v1");
});

test("a run scored under the old lifecycle keeps the version that scored it", () => {
  const sqlite = migrated();

  sqlite.exec(
    `INSERT INTO cohorts (id, slug, name, join_code, active)
     VALUES ('cohort_x', 'test', 'Test', 'JOIN', 1);
     INSERT INTO teams (id, cohort_id, name, repo_owner, repo_name, repo_full_name,
                        repo_url, default_branch)
     VALUES ('team_x', 'cohort_x', 'Team', 'owner', 'repo', 'owner/repo',
             'https://github.com/owner/repo', 'main');`,
  );
  sqlite
    .prepare(
      `INSERT INTO runs (id, team_id, benchmark_id, benchmark_version, contract_version,
                         mode, status, branch, sha, created_at, scorer_version)
       VALUES ('run_old', 'team_x', 'vision-recognition', 2, 'cogworks.submissions.v2',
               'official', 'succeeded', 'main', '0123456789abcdef0123456789abcdef01234567', 1780000000000,
               'recognition-v1')`,
    )
    .run();
  // Re-running the bump must not reach into history. Applying it twice is
  // also what a replayed migration does.
  sqlite.exec(
    readFileSync(join(MIGRATIONS, "0039_week2_recognition_v2.sql"), "utf8"),
  );

  const row = sqlite
    .prepare("SELECT scorer_version FROM runs WHERE id = 'run_old'")
    .get() as { scorer_version: string };

  assert.equal(row.scorer_version, "recognition-v1");
});
