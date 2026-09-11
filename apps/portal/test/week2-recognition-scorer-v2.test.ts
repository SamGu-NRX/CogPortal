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
 *
 * Unlike the `freshDb` helpers elsewhere in this directory, this one replays
 * `0002_seed.sql` too. Those tests skip it to start from an empty database;
 * this one needs the rows it creates, because they are exactly what the bump
 * must not touch: `vision-recognition@1` and nine runs recorded against it.
 * A reviewer showed that without them, dropping `AND version = 2` from the
 * migration still passed every assertion here.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const BUMP = "0039_week2_recognition_v2.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function replay(files: string[], sqlite = new DatabaseSync(":memory:")): DatabaseSync {
  for (const file of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return sqlite;
}

function migrated(): DatabaseSync {
  return replay(migrationFiles());
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

function runVersions(sqlite: DatabaseSync): Array<{ id: string; scorer_version: string }> {
  return sqlite
    .prepare(
      "SELECT id, scorer_version FROM runs WHERE benchmark_id = 'vision-recognition' ORDER BY id",
    )
    .all() as Array<{ id: string; scorer_version: string }>;
}

test("the recognition catalog row scores as recognition-v2", () => {
  const found = scorerVersions(migrated());

  assert.equal(found["vision-recognition@2"], "recognition-v2");
});

test("the bump moves that row and nothing else", () => {
  const found = scorerVersions(migrated());

  // v1 is the same benchmark id and is the row a migration missing its version
  // clause would also hit. It was retired by 0013 and still carries the scorer
  // version that scored against it.
  assert.equal(found["vision-recognition@1"], "1");
  // Clustering shares the Week 2 submodule and its own v2 bump landed in
  // 0026; nothing about this lifecycle change touches it. Week 1 and Week 3
  // are named so a future catalog-wide UPDATE cannot pass this file.
  assert.equal(found["vision-clustering@2"], "clustering-v2");
  assert.equal(found["language-search@1"], "retrieval-v4");
  assert.equal(found["audio-identification@1"], "identification-v1");
});

test("a run scored under the old lifecycle keeps the version that scored it", () => {
  // Everything up to but not including the bump, so the run below is inserted
  // into a database that still says recognition-v1 and the bump then runs for
  // the first time against it. Applying the bump and only then inserting would
  // test a replay, which is the one case where there is nothing to rewrite.
  const files = migrationFiles();
  const at = files.indexOf(BUMP);
  assert.ok(at > 0, `${BUMP} is missing from ${MIGRATIONS}`);
  const sqlite = replay(files.slice(0, at));

  assert.equal(scorerVersions(sqlite)["vision-recognition@2"], "recognition-v1");

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
  const before = runVersions(sqlite);

  replay(files.slice(at), sqlite);

  assert.equal(scorerVersions(sqlite)["vision-recognition@2"], "recognition-v2");
  // Every recognition run, the one above and the nine the seed records against
  // v1, still says what scored it.
  assert.deepEqual(runVersions(sqlite), before);
  assert.ok(before.some((row) => row.id === "run_old" && row.scorer_version === "recognition-v1"));
});
