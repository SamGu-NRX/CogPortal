import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  officialAttempts,
  runs,
  runSurfaces,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { ApiHttpError } from "../worker/http/errors.ts";
import {
  promotePracticeRun,
  type RunActor,
} from "../worker/services/run-actions.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const BENCHMARK_ID = "vision-recognition";
const PRACTICE_RUN_ID = "run_practice";
const SURFACE_ID = "surface_promotion_test";

interface Harness {
  db: Database;
  binding: unknown;
}

function freshDb(): Harness {
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

  const binding = {
    prepare,
    // D1 commits a batch as one implicit transaction; mirror that so the
    // dispatch-failure cleanup's atomicity claim is exercised, not stubbed.
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db: drizzle(binding as never), binding };
}

function env(binding: unknown, provider: "fixture" | "modal", queue?: { send(): Promise<void> }): Env {
  return {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: provider,
    PUBLIC_ORIGIN: "https://portal.example",
    MODAL_RUNNER_URL: "https://runner.example",
    RUNNER_SIGNING_SECRET: "test-signing-secret-that-is-long-enough",
    RUN_QUEUE: queue,
  } as unknown as Env;
}

async function seedPromotion(db: Database): Promise<RunActor> {
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  await db.insert(users).values({
    id: "user_test",
    name: "Ada",
    email: "ada@example.test",
    githubLogin: "ada",
    cohortId: "cohort_test",
  });
  await db.insert(teams).values({
    id: "team_test",
    cohortId: "cohort_test",
    name: "Test team",
    description: null,
    repoOwner: FIXTURE_REPO.owner,
    repoName: FIXTURE_REPO.name,
    repoFullName: FIXTURE_REPO.fullName,
    repoUrl: FIXTURE_REPO.url,
    defaultBranch: FIXTURE_REPO.defaultBranch,
    repoId: FIXTURE_REPO.repositoryId,
  });
  await db.insert(benchmarks).values({
    id: BENCHMARK_ID,
    version: 1,
    contractVersion: "cogworks.submissions.v1",
    entryPointName: "submission",
    title: "Vision Recognition",
    module: "vision",
    summary: "Test benchmark",
    active: true,
    primaryMetricKey: "accuracy",
    pluginVersion: "1",
    datasetVersion: "official-v1",
    scorerVersion: "1",
    runtimeVersion: "python-3.11",
  });
  await db.insert(runSurfaces).values({
    id: SURFACE_ID,
    teamId: "team_test",
    createdByUserId: "user_test",
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    localRunId: null,
    supersedesSurfaceId: null,
    discordChannelId: null,
    discordMessageId: null,
    discordNonceGeneration: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(runs).values({
    id: PRACTICE_RUN_ID,
    teamId: "team_test",
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    mode: "practice",
    status: "succeeded",
    branch: "main",
    sha: "a".repeat(40),
    repositoryId: FIXTURE_REPO.repositoryId,
    parentRunId: null,
    attemptNumber: null,
    failureCategory: null,
    failurePhase: null,
    failureDetail: null,
    failureConsumedAttempt: false,
    log: null,
    createdAt: NOW,
    finishedAt: NOW + 1_000,
    provider: "modal",
    preparedArtifactId: "artifact_test",
    datasetVersion: "practice-v1",
    scorerVersion: "1",
    runtimeVersion: "python-3.11",
    surfaceId: SURFACE_ID,
  });

  const [team] = await db.select().from(teams).where(eq(teams.id, "team_test"));
  assert.ok(team);
  return {
    userId: "user_test",
    githubLogin: "ada",
    team,
    role: "write",
  };
}

async function seedOfficial(
  db: Database,
  status: "failed" | "succeeded",
): Promise<string> {
  const runId = `run_official_${status}`;
  await db.insert(runs).values({
    id: runId,
    teamId: "team_test",
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    mode: "official",
    status,
    branch: "main",
    sha: "a".repeat(40),
    repositoryId: FIXTURE_REPO.repositoryId,
    parentRunId: PRACTICE_RUN_ID,
    attemptNumber: 1,
    failureCategory: status === "failed" ? "provider" : null,
    failurePhase: status === "failed" ? "queued" : null,
    failureDetail: status === "failed" ? "The provider stopped the run." : null,
    failureConsumedAttempt: false,
    refundedAt: status === "failed" ? NOW + 2_000 : null,
    log: null,
    createdAt: NOW + 1_000,
    finishedAt: NOW + 2_000,
    provider: "modal",
    preparedArtifactId: "artifact_test",
    datasetVersion: "official-v1",
    scorerVersion: "1",
    runtimeVersion: "python-3.11",
    surfaceId: SURFACE_ID,
  });
  if (status === "succeeded") {
    await db.insert(officialAttempts).values({
      id: "attempt_succeeded",
      teamId: "team_test",
      benchmarkId: BENCHMARK_ID,
      benchmarkVersion: 1,
      runId,
      attemptNumber: 1,
      consumed: true,
      claimedAt: NOW + 1_000,
    });
  }
  return runId;
}

test("a failed official run blocks same-surface re-promotion", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await seedOfficial(db, "failed");

  await assert.rejects(
    promotePracticeRun(env(binding, "fixture"), actor, PRACTICE_RUN_ID),
    (error: unknown) => {
      assert.ok(error instanceof ApiHttpError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "not_promotable");
      assert.match(error.message, /failed official run/);
      return true;
    },
  );
});

test("a succeeded official run remains idempotent on the same surface", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const officialRunId = await seedOfficial(db, "succeeded");

  assert.deepEqual(
    await promotePracticeRun(env(binding, "fixture"), actor, PRACTICE_RUN_ID),
    { runId: officialRunId, surfaceId: SURFACE_ID },
  );
});

test("an official dispatch failure releases its unconsumed claim", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const queue = {
    async send() {
      throw new Error("dispatch unavailable");
    },
  };

  await assert.rejects(
    promotePracticeRun(env(binding, "modal", queue), actor, PRACTICE_RUN_ID),
    (error: unknown) => {
      assert.ok(error instanceof ApiHttpError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "provider_unconfigured");
      return true;
    },
  );

  const claims = await db.select().from(officialAttempts);
  assert.equal(claims.length, 0);
  const [official] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.parentRunId, PRACTICE_RUN_ID), eq(runs.mode, "official")));
  assert.ok(official);
  assert.equal(official.status, "failed");
  assert.equal(official.failureCategory, "provider");
});

test("dispatch-failure cleanup commits the failed run and the claim release together", async () => {
  // The repair pairs two writes: mark the run failed, delete the claim. A
  // partial commit is worse than either order alone (a failed run keeping its
  // claim spends an attempt; a claimless queued run wedges the active-run
  // index), so the service issues them as one D1 batch. This pins the batch
  // by observing both effects and that no intermediate state satisfies one
  // without the other after the call returns.
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const queue = {
    async send() {
      throw new Error("dispatch unavailable");
    },
  };

  await assert.rejects(promotePracticeRun(env(binding, "modal", queue), actor, PRACTICE_RUN_ID));

  const [official] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.parentRunId, PRACTICE_RUN_ID), eq(runs.mode, "official")));
  const claims = await db.select().from(officialAttempts);
  // Both halves, atomically observed: terminal run AND zero claims. A tree
  // where either assertion fails while the other passes is the partial-write
  // state the batch exists to forbid.
  assert.equal(official?.status, "failed");
  assert.equal(claims.length, 0);
  // The claim is released (zero rows above), but the failed official run now
  // occupies this surface, so same-surface re-promotion is refused: that is
  // the B-04 fix composing with this one. The attempt itself is reusable
  // through a fresh surface, which the refusal's message points at.
  await assert.rejects(
    promotePracticeRun(env(binding, "fixture"), actor, PRACTICE_RUN_ID),
    (error: unknown) => {
      assert.ok(error instanceof ApiHttpError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "not_promotable");
      return true;
    },
  );
});
