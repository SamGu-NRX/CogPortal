import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import {
  cohorts,
  leaderboardSelections,
  runMetrics,
  runs,
  teams,
} from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { getLeaderboardReadModel } from "../worker/services/leaderboard.ts";

/**
 * An archive row on the leaderboard is labeled "2026 cohort, anonymized". The
 * label is only true if nothing in the response can be walked back to the
 * original team: the repository URL names a GitHub account outright, and a
 * commit SHA resolves to its repository through GitHub's commit search. Both
 * are stored on the row (the columns are NOT NULL and the run needs a sha), so
 * the guarantee has to hold at the boundary, in the read model, which is what
 * this test pins. Live rows keep both, because a live leaderboard row is a
 * claim about code somebody can go read.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function freshBinding(): unknown {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));

  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let bound: never[] = [];
    const prepared = {
      bind(...params: unknown[]) {
        bound = params as never[];
        return prepared;
      },
      async run() {
        return { success: true, meta: statement.run(...bound) };
      },
      async all() {
        return { success: true, results: statement.all(...bound) };
      },
      async raw() {
        statement.setReturnArrays(true);
        const rows = statement.all(...bound);
        statement.setReturnArrays(false);
        return rows;
      },
    };
    return prepared;
  }
  return { prepare };
}

const REAL_SHA = "71258046e60fecd3295c0b52236fc6e476b0e9cf";
const REAL_URL = "https://github.com/some-student/week1-capstone";

async function seeded() {
  const binding = freshBinding();
  const env = { DB: binding } as unknown as Env;
  const db = drizzle(binding as never);
  await db.insert(cohorts).values({
    id: "cohort_t",
    slug: "t",
    name: "Test cohort",
    joinCode: "JOIN-T",
    active: true,
  });
  // audio-identification v1 is inserted by migration 0020, which the harness runs.
  const rows: Array<{ id: string; provenance: "live" | "archive"; score: number }> = [
    { id: "team_live", provenance: "live", score: 0.5 },
    { id: "team_archive", provenance: "archive", score: 0.6 },
  ];
  for (const row of rows) {
    await db.insert(teams).values({
      id: row.id,
      cohortId: "cohort_t",
      name: row.id,
      repoOwner: "some-student",
      repoName: "week1-capstone",
      repoFullName: `some-student/${row.id}`,
      repoUrl: REAL_URL,
      defaultBranch: "main",
      provenance: row.provenance,
    });
    const runId = `run_${row.id}`;
    await db.insert(runs).values({
      id: runId,
      teamId: row.id,
      benchmarkId: "audio-identification",
      benchmarkVersion: 1,
      contractVersion: "cogworks.submissions.v2",
      mode: "official",
      status: "succeeded",
      branch: "main",
      sha: REAL_SHA,
      attemptNumber: 1,
      createdAt: 10,
      finishedAt: 20,
      provider: "archive",
    });
    await db.insert(runMetrics).values({
      runId,
      key: "identification_score",
      label: "Identification score",
      value: row.score,
      higherIsBetter: true,
      isPrimary: true,
      precision: 4,
    });
    await db.insert(leaderboardSelections).values({
      teamId: row.id,
      benchmarkId: "audio-identification",
      benchmarkVersion: 1,
      runId,
      selectedAt: 20,
    });
  }
  return env;
}

test("an archive row carries no repository URL and no commit", async () => {
  const env = await seeded();
  const board = await getLeaderboardReadModel(env, "audio-identification");
  const archive = board.entries.find((entry) => entry.provenance === "archive");
  assert.ok(archive, "the archive team is on the board");
  assert.equal(archive.repoUrl, null);
  assert.equal(archive.sha, "");
  assert.equal(archive.shortSha, "");

  // The whole serialized response, not just the fields we know about.
  const body = JSON.stringify(archive);
  assert.doesNotMatch(body, /github\.com/);
  assert.doesNotMatch(body, /[0-9a-f]{40}/);
  assert.doesNotMatch(body, /some-student/);
});

test("a live row keeps both, because its score is a claim about readable code", async () => {
  const env = await seeded();
  const board = await getLeaderboardReadModel(env, "audio-identification");
  const live = board.entries.find((entry) => entry.provenance === "live");
  assert.ok(live);
  assert.equal(live.repoUrl, REAL_URL);
  assert.equal(live.sha, REAL_SHA);
  assert.equal(live.shortSha, REAL_SHA.slice(0, 7));
});
