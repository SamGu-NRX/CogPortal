import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { FIXTURE_SCENARIOS } from "@cogworks/contracts/fixtures";
import type { Database } from "../worker/db/client.ts";
import { cohorts, runs, teams } from "../worker/db/schema.ts";
import { fixtureLog } from "../worker/execution/fixture.ts";
import { syncRun } from "../worker/execution/sync.ts";

/**
 * A fixture failure has to read as the track it ran on, on the failure card
 * and in the log alike. A Language run on `null-descriptor` once showed
 * Vision's `recognize() at faces.py:87` on its card while its log showed the
 * Language error, because the sync stored the scenario's default detail
 * instead of the per-track one, and the log's traceback frame was Vision's for
 * every track.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
/** Long enough past createdAt that every fixture phase has elapsed. */
const FIXTURE_RUN_MS = 30_000;
const LANGUAGE = "language-search";
const VISION = "vision-recognition";

function freshDb(): Database {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));

  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let bound: SQLInputValue[] = [];
    const prepared = {
      bind(...params: SQLInputValue[]) {
        bound = params;
        return prepared;
      },
      async run() {
        return { success: true, meta: statement.run(...bound) };
      },
      execute() {
        const results = statement.all(...bound);
        const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
        return { success: true, results, meta: { changes } };
      },
      async all() {
        return prepared.execute();
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
  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      // D1 commits a batch as one transaction; syncRun writes through one.
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // SAFETY: the binding implements the D1 methods Drizzle uses here, without
  // Cloudflare-only methods such as database export or sessions.
  return drizzle(binding as never);
}

/** Seeds a practice fixture run (only practice runs keep a log) and syncs it
 *  past its scripted failure. */
async function failedRun(benchmarkId: string, branch: string) {
  const db = freshDb();
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  await db.insert(teams).values({
    id: "team_a",
    cohortId: "cohort_test",
    name: "team_a",
    description: null,
    repoOwner: "cogworks-test",
    repoName: "team_a",
    repoFullName: "cogworks-test/team_a",
    repoUrl: "https://github.com/cogworks-test/team_a",
    defaultBranch: "main",
  });
  await db.insert(runs).values({
    id: "run_1",
    teamId: "team_a",
    benchmarkId,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    mode: "practice",
    status: "queued",
    branch,
    sha: "a".repeat(40),
    repositoryId: null,
    parentRunId: null,
    attemptNumber: null,
    failureCategory: null,
    failurePhase: null,
    failureDetail: null,
    failureConsumedAttempt: false,
    refundedAt: null,
    log: null,
    createdAt: NOW,
    finishedAt: null,
    provider: "fixture",
    lastEventSequence: -1,
    surfaceId: null,
  });
  const [row] = await db.select().from(runs).where(eq(runs.id, "run_1"));
  assert.ok(row);
  const synced = await syncRun(db, row, NOW + FIXTURE_RUN_MS);
  assert.equal(synced.status, "failed");
  assert.ok(synced.log, "a finished practice run keeps its log");
  return { ...synced, log: synced.log };
}

function scriptedFailure(branch: string) {
  const outcome = FIXTURE_SCENARIOS.find((scenario) => scenario.branch === branch)?.outcome;
  assert.ok(outcome?.kind === "failed", `${branch} is not a scripted failure`);
  return outcome;
}

test("a Language run on null-descriptor stores and logs the Language failure", async () => {
  const run = await failedRun(LANGUAGE, "null-descriptor");
  const languageDetail = scriptedFailure("null-descriptor").detailByBenchmark?.[LANGUAGE];
  assert.ok(languageDetail, "null-descriptor has no Language wording to compare against");

  assert.equal(run.failureDetail, languageDetail);
  assert.ok(run.log.includes(languageDetail), "the log's last line is the same detail");
  assert.ok(run.log.includes('File "search.py", line 52, in embed_text'));
  assert.doesNotMatch(run.log, /faces\.py|recognize/);
});

test("a Vision run on null-descriptor keeps the Vision failure", async () => {
  const run = await failedRun(VISION, "null-descriptor");
  const visionDetail = scriptedFailure("null-descriptor").detail;

  assert.equal(run.failureDetail, visionDetail);
  assert.ok(run.log.includes(visionDetail));
  assert.ok(run.log.includes('File "faces.py", line 87, in recognize'));
  assert.doesNotMatch(run.log, /search\.py|embed_text/);
});

test("no scripted failure puts a Vision frame into a Language log", () => {
  for (const scenario of FIXTURE_SCENARIOS) {
    if (scenario.outcome.kind !== "failed") continue;
    const log = fixtureLog("run_1", scenario.branch, "a".repeat(40), LANGUAGE);
    assert.doesNotMatch(log, /faces\.py|recognize/, `${scenario.branch} logs Vision's frame under Language`);
  }
});

test("a Clustering run fails in Clustering's words, not recognition's", async () => {
  const CLUSTERING = "vision-clustering";
  for (const branch of ["null-descriptor", "raw-tuples"]) {
    const run = await failedRun(CLUSTERING, branch);
    const clusteringDetail = scriptedFailure(branch).detailByBenchmark?.[CLUSTERING];
    assert.ok(clusteringDetail, `${branch} has no Clustering wording`);
    assert.equal(run.failureDetail, clusteringDetail);
    assert.doesNotMatch(run.log, /recognize|"box","identity"/, `${branch} logs recognition's failure under Clustering`);
  }
});

test("a fixture log stops at the stage that failed", () => {
  const log = (branch: string) => fixtureLog("run_1", branch, "a".repeat(40), VISION);
  const install = log("loose-pins");
  assert.doesNotMatch(install, /entry-point discovery|contract check|eval case/);
  const contract = log("missing-adapter");
  assert.match(contract, /entry-point discovery/);
  assert.doesNotMatch(contract, /contract check: adapter factory loaded|eval case/);
  const evaluating = log("null-descriptor");
  assert.match(evaluating, /eval case 016\/032 complete/);
  assert.doesNotMatch(evaluating, /eval case 017\/032/);
  assert.match(log("raw-tuples"), /eval case 032\/032 complete/);
  assert.match(log("main"), /run completed successfully/);
});
