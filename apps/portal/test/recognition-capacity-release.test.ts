import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Database } from "../worker/db/client.ts";
import {
  cohorts,
  leaderboardSelections,
  officialAttempts,
  runMetrics,
  runs,
  teamMembers,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";
import { insertRunWithCapacity, readRunAccounting } from "../worker/services/run-accounting.ts";

/**
 * 0048: Week 2 recognition runs scored under recognition-v1 give back the
 * quota they held once 0044 moved the scorer. Every migration runs first, on
 * an empty database, as it does on D1; the release is then applied again to
 * the rows each test writes, which is the case that matters in production.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const RELEASE = readFileSync(join(MIGRATIONS, "0048_recognition_v1_capacity_release.sql"), "utf8");
const SECRET = "test-signing-secret-that-is-long-enough";
const NOW = 1_780_000_000_000;
const SCOPE = { teamId: "team_1", benchmarkId: "vision-recognition", benchmarkVersion: 2 };

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const binding = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: never[] = [];
      const prepared = {
        bind(...params: unknown[]) { bound = params as never[]; return prepared; },
        async run() { return { success: true, meta: statement.run(...bound) }; },
        execute() {
          const results = statement.all(...bound);
          const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
          return { success: true, results, meta: { changes } };
        },
        async all() { return { success: true, results: statement.all(...bound) }; },
        async raw() {
          statement.setReturnArrays(true);
          const rows = statement.all(...bound);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
    // D1 commits a batch as one transaction.
    async batch(statements: Array<{ execute(): unknown }>) {
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
  const db = drizzle(binding as never) as unknown as Database;
  return { db, binding, release: () => sqlite.exec(RELEASE) };
}

async function seed(db: Database) {
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values({ id: "user_1", name: "Student", email: "student@example.test", cohortId: "cohort_1" });
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Team", description: null,
    repoOwner: "course", repoName: "team", repoFullName: "course/team",
    repoUrl: "https://github.com/course/team", defaultBranch: "main", repoId: 7,
  });
  // The student starts the runs below; admission checks they are on the team.
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_1", role: "write" });
}

let counter = 0;
async function run(db: Database, over: Partial<typeof runs.$inferInsert>) {
  counter += 1;
  const row = {
    id: `run_${String(counter).padStart(4, "0")}`, teamId: "team_1", benchmarkId: "vision-recognition",
    benchmarkVersion: 2, contractVersion: "cogworks.submissions.v1", mode: "practice" as const,
    status: "succeeded" as const, branch: "main", sha: "a".repeat(40), repositoryId: 7,
    repositoryFullName: "course/team", createdAt: NOW + counter, finishedAt: NOW + counter + 1,
    provider: "modal" as const, scorerVersion: "recognition-v1", surfaceId: null, ...over,
  };
  await db.insert(runs).values(row);
  return row;
}

function pending(mode: "practice" | "official") {
  return {
    id: `run_new_${mode}`, teamId: "team_1", benchmarkId: "vision-recognition", benchmarkVersion: 2,
    contractVersion: "cogworks.submissions.v1", mode, status: "queued" as const, branch: "main",
    sha: "b".repeat(40), repositoryId: 7, repositoryFullName: "course/team", createdAt: NOW + 10_000,
    provider: "modal" as const, scorerVersion: "recognition-v2", surfaceId: null,
  };
}

test("three recognition-v1 official attempts stop exhausting the corrected board's quota", async () => {
  const { db, release } = freshDb();
  await seed(db);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const official = await run(db, { mode: "official", attemptNumber: attempt });
    await db.insert(runMetrics).values({
      runId: official.id, key: "accuracy", label: "Accuracy", value: 0.9, unit: null,
      higherIsBetter: true, isPrimary: true, precision: 3,
    });
    await db.insert(officialAttempts).values({
      id: `claim_${attempt}`, ...SCOPE, runId: official.id, attemptNumber: attempt, consumed: true, claimedAt: NOW,
    });
  }
  await db.insert(leaderboardSelections).values({ ...SCOPE, runId: "run_0003", selectedAt: NOW });
  assert.equal((await readRunAccounting(db, SCOPE)).officialUsed, 3);
  assert.equal((await insertRunWithCapacity(db, pending("official"), "user_1")).meta.changes, 0, "precondition: the old limit holds");

  const before = {
    runs: await db.select().from(runs),
    metrics: await db.select().from(runMetrics),
    selections: await db.select().from(leaderboardSelections),
    attempts: await db.select().from(officialAttempts),
  };
  release();

  assert.equal((await readRunAccounting(db, SCOPE)).officialUsed, 0);
  assert.equal((await insertRunWithCapacity(db, pending("official"), "user_1")).meta.changes, 1);
  // History is untouched apart from the release time.
  const after = (await db.select().from(runs)).filter((row) => row.id !== "run_new_official");
  assert.deepEqual(after.map(({ refundedAt: _released, ...row }) => row),
    before.runs.map(({ refundedAt: _released, ...row }) => row));
  assert.ok(after.every((row) => row.refundedAt !== null));
  assert.deepEqual(await db.select().from(runMetrics), before.metrics);
  assert.deepEqual(await db.select().from(leaderboardSelections), before.selections);
  assert.deepEqual(await db.select().from(officialAttempts), before.attempts);
});

test("ten recognition-v1 practice runs stop exhausting practice", async () => {
  const { db, release } = freshDb();
  await seed(db);
  for (let i = 0; i < 10; i += 1) await run(db, {});
  assert.equal((await insertRunWithCapacity(db, pending("practice"), "user_1")).meta.changes, 0, "precondition: the old limit holds");

  release();

  assert.equal((await readRunAccounting(db, SCOPE)).practiceUsed, 0);
  assert.equal((await insertRunWithCapacity(db, pending("practice"), "user_1")).meta.changes, 1);
});

test("the release touches only recognition-v1 work that counted, and is idempotent", async () => {
  const { db, release } = freshDb();
  await seed(db);
  const released = await run(db, {});
  const corrected = await run(db, { scorerVersion: "recognition-v2" });
  const failed = await run(db, { status: "failed", finishedAt: NOW });
  const cancelled = await run(db, { status: "cancelled" });
  const otherVersion = await run(db, { benchmarkVersion: 1 });
  const otherBenchmark = await run(db, { benchmarkId: "vision-clustering" });
  const alreadyRefunded = await run(db, { refundedAt: NOW - 5 });

  release();
  const first = new Map((await db.select().from(runs)).map((row) => [row.id, row.refundedAt]));
  release();
  const second = new Map((await db.select().from(runs)).map((row) => [row.id, row.refundedAt]));

  assert.notEqual(first.get(released.id), null);
  for (const untouched of [corrected, failed, cancelled, otherVersion, otherBenchmark]) {
    assert.equal(first.get(untouched.id), null, `${untouched.id} was released`);
  }
  assert.equal(first.get(alreadyRefunded.id), NOW - 5, "an earlier refund time was overwritten");
  assert.deepEqual(second, first, "a second application changed something");
});

async function postRunnerEvent(env: Env, event: unknown) {
  const app = new Hono<AppEnv>();
  registerRunnerEventRoutes(app);
  app.onError(handleError);
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.fetch(new Request("http://localhost/internal/v1/runner/events", {
    method: "POST", body,
    headers: { "X-Cogworks-Key-Id": "runner-v1", "X-Cogworks-Timestamp": timestamp,
      "X-Cogworks-Signature": `v1=${await hmacSignature(SECRET, timestamp, body)}` },
  }), env);
}

test("an old run still going keeps blocking a start, and completing later does not charge it", async () => {
  const { db, binding, release } = freshDb();
  await seed(db);
  for (let i = 0; i < 9; i += 1) await run(db, {});
  const inFlight = await run(db, { status: "evaluating", finishedAt: null });

  release();

  const during = await readRunAccounting(db, SCOPE);
  assert.equal(during.practiceUsed, 0);
  assert.equal(during.practiceReserved, 1);
  assert.equal(during.activeRuns, 1);
  // Drizzle wraps the driver's error; the active-run index is what refused it.
  await assert.rejects(insertRunWithCapacity(db, pending("practice"), "user_1"),
    (error: unknown) => /UNIQUE constraint failed/i.test(String((error as { cause?: unknown }).cause)),
    "a start was admitted beside the old active run");

  // SAFETY: the runner-event route reads only these bindings.
  const env = { DB: binding, RUNNER_SIGNING_SECRET: SECRET, EXECUTION_PROVIDER: "modal" } as unknown as Env;
  const response = await postRunnerEvent(env, {
    protocolVersion: "1", type: "completed", eventId: "evt_old_done", runId: inFlight.id,
    sequence: 3, occurredAt: Date.now(), preparedArtifactId: "artifact_old",
    environmentDigest: "d".repeat(64), sanitizedLog: null,
    result: {
      protocolVersion: "1", benchmarkId: "vision-recognition", benchmarkVersion: 2,
      metrics: [{ key: "accuracy", label: "Accuracy", value: 1, unit: null, higherIsBetter: true, primary: true, precision: 3 }],
      diagnostics: [], outputDigest: "e".repeat(64),
    },
  });
  assert.equal(response.status, 200, await response.text());

  const [completed] = await db.select().from(runs).where(and(eq(runs.id, inFlight.id), eq(runs.status, "succeeded")));
  assert.ok(completed, "the old run did not complete");
  assert.notEqual(completed.refundedAt, null, "completion restored the charge");
  assert.deepEqual(await readRunAccounting(db, SCOPE), {
    practiceUsed: 0, officialUsed: 0, practiceReserved: 0, officialReserved: 0, activeRuns: 0,
  });
  assert.equal((await insertRunWithCapacity(db, pending("practice"), "user_1")).meta.changes, 1);
});
