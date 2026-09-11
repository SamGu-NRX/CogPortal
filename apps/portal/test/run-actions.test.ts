import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { DashboardSchema, type Dashboard } from "@cogworks/contracts/schema";
import { Hono } from "hono";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardPage } from "../src/routes/DashboardPage.tsx";
import { createAuth } from "../worker/auth/better-auth.ts";
import { registerDashboardRoutes } from "../worker/routes/dashboard.ts";
import { buildRunSurfaceSnapshot } from "../worker/services/run-surfaces.ts";
import { serializeRunDetail } from "../worker/http/serializers.ts";
import type { AppEnv } from "../worker/env.ts";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cliDevices,
  cohorts,
  leaderboardSelections,
  localRunSessions,
  officialAttempts,
  runs,
  runSurfaces,
  runMetrics,
  teamMembers,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { ApiHttpError } from "../worker/http/errors.ts";
import { runSourceRefusal } from "../worker/services/run-source.ts";
import {
  performRunSurfaceMutation,
  promotePracticeRun,
  publishOfficialRun,
  rerunHostedSurface,
  startPracticeRun,
  type RunActor,
} from "../worker/services/run-actions.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const BENCHMARK_ID = "vision-recognition";
const PRACTICE_RUN_ID = "run_practice";
// Shaped like a real one: publishRunSurface validates this id, and the
// dispatch tests below now reach that publish, because a run the provider
// accepted is no longer failed on the way past.
const SURFACE_ID = "surface_0a1b2c3d4e5f60718293";

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

/** Counts snapshot publications, so a refusal can be shown to have had no
 *  observable effect rather than only to have thrown. */
let hubPublications = 0;

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
    // A promotion that reaches the end publishes the run surface. Until a
    // dispatch could survive its own rejection, no test here got that far.
    RUN_SURFACES: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          hubPublications += 1;
          return new Response(null, { status: 200 });
        },
      }),
    },
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
    // Deliberately not the team's current name. An official attempt has to
    // inherit the repository its practice run used, and a promotion that read
    // the team instead would come back with FIXTURE_REPO.fullName.
    repositoryFullName: "some-org/the-repository-it-ran-from",
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
      assert.match(error.message, /already ran and failed.*new practice run/);
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

for (const status of [400, 401, 502, 503, 200, 302, 202]) {
  test(`direct Modal dispatch returning ${status} ${status >= 400 && status < 500 ? "fails the run and releases its claim" : "keeps the queued run and its claim"}`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (input) => {
      assert.equal(input, "https://runner.example");
      requests += 1;
      return new Response(null, { status });
    };
    try {
      const promotion = promotePracticeRun(env(binding, "modal"), actor, PRACTICE_RUN_ID);
      const rejected = status >= 400 && status < 500;
      if (rejected) {
        await assert.rejects(promotion, (error: unknown) => {
          assert.ok(error instanceof ApiHttpError);
          assert.equal(error.status, 502);
          assert.equal(error.code, "provider_unconfigured");
          return true;
        });
      } else {
        assert.equal((await promotion).surfaceId, SURFACE_ID);
      }
      assert.equal(requests, 1);
      const [official] = await db.select().from(runs)
        .where(and(eq(runs.parentRunId, PRACTICE_RUN_ID), eq(runs.mode, "official")));
      assert.ok(official);
      assert.equal(official.status, rejected ? "failed" : "queued");
      assert.equal(official.dispatchAttempts, status === 202 ? 1 : 0);
      assert.equal(official.failureCategory, rejected ? "provider" : null);
      const claims = await db.select().from(officialAttempts);
      assert.equal(claims.length, rejected ? 0 : 1);
      if (!rejected) assert.equal(claims[0].runId, official.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const callbackLanded of [false, true]) {
  test(`a direct Modal network error keeps the ${callbackLanded ? "callback's preparing" : "queued"} run and its claim`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://runner.example");
      requests += 1;
      if (callbackLanded) {
        const job = JSON.parse(String(init?.body)) as { runId: string };
        await db.update(runs)
          .set({ status: "preparing", lastEventSequence: 0 })
          .where(eq(runs.id, job.runId));
      }
      throw new Error("dispatch acknowledgement lost");
    };
    try {
      const promoted = await promotePracticeRun(env(binding, "modal"), actor, PRACTICE_RUN_ID);
      assert.equal(promoted.surfaceId, SURFACE_ID);
      assert.equal(requests, 1);
      const [official] = await db.select().from(runs).where(eq(runs.id, promoted.runId));
      assert.ok(official);
      assert.equal(official.status, callbackLanded ? "preparing" : "queued");
      if (callbackLanded) assert.equal(official.lastEventSequence, 0);
      assert.equal(official.failureCategory, null);
      assert.equal(official.failureDetail, null);
      assert.equal(
        official.repositoryFullName,
        "some-org/the-repository-it-ran-from",
        "the official attempt lost the repository its practice run used",
      );
      const claims = await db.select().from(officialAttempts);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].runId, official.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("a callback that lands before the dispatch rejects leaves the live run alone", async () => {
  // Modal spawns the job before its endpoint answers, and the portal's POST
  // gives up after fifteen seconds. So a rejection here can belong to a run
  // that is already executing and has already reported. Unknown acceptance is
  // not known rejection: this used to overwrite `preparing` with "could not be
  // queued" and hand back an official attempt mid-run.
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const officialRun = () =>
    db
      .select()
      .from(runs)
      .where(and(eq(runs.parentRunId, PRACTICE_RUN_ID), eq(runs.mode, "official")));
  const queue = {
    async send() {
      const [official] = await officialRun();
      await db
        .update(runs)
        .set({ status: "preparing", lastEventSequence: 0 })
        .where(eq(runs.id, official!.id));
      throw new Error("dispatch acknowledgement lost");
    },
  };

  const promoted = await promotePracticeRun(env(binding, "modal", queue), actor, PRACTICE_RUN_ID);
  assert.equal(promoted.surfaceId, SURFACE_ID);

  const [official] = await officialRun();
  assert.equal(official?.status, "preparing", "the callback's state survived");
  assert.equal(official?.failureCategory, null);
  assert.equal(official?.failureDetail, null);
  const claims = await db.select().from(officialAttempts);
  assert.equal(claims.length, 1, "a live official run keeps its claim");
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

test("a practice run records the repository it is starting from", async () => {
  // The one place the name is written. Without this, deleting that line leaves
  // every run unattributed and every other test still green.
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const started = await startPracticeRun(env(binding, "fixture"), actor, {
    benchmarkId: BENCHMARK_ID,
  });

  const [row] = await db.select().from(runs).where(eq(runs.id, started.runId));
  assert.ok(row);
  assert.equal(row.repositoryFullName, FIXTURE_REPO.fullName);
  assert.equal(row.repositoryId, FIXTURE_REPO.repositoryId, "the id and the name disagree");
});

/* ── Acting on a run after the repository changed ─────────────────────── */

/**
 * A team has one connected repository and every write is authorised against
 * it, so a new promotion, rerun or publication has to be about that
 * repository. History stays readable and an existing selection stays selected;
 * only new mutations are refused. Matched on the id, so a rename keeps working.
 */

/**
 * Leave the run recording a repository the team is not connected to.
 *
 * Equivalent to the team having moved on, and isolated from it on purpose: the
 * permission check ahead of this rule short-circuits only for the fixture
 * repository, so moving the team would fail on GitHub access first and never
 * reach the rule under test. The real end-to-end switch is exercised through
 * POST /team/repository in the browser.
 */
async function runCameFromElsewhere(db: Database, runId: string): Promise<void> {
  await db
    .update(runs)
    .set({
      repositoryId: FIXTURE_REPO.repositoryId + 1,
      repositoryFullName: "some-student/week3-capstone",
    })
    .where(eq(runs.id, runId));
}

test("a run from a repository the team has left cannot be promoted", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await runCameFromElsewhere(db, PRACTICE_RUN_ID);

  await assert.rejects(
    promotePracticeRun(env(binding, "fixture"), actor, PRACTICE_RUN_ID),
    (error: unknown) => error instanceof ApiHttpError && error.code === "source_changed",
  );

  // Nothing was written: no official row, and no attempt claimed against the
  // team's budget for a run it refused.
  const official = await db.select().from(runs).where(eq(runs.mode, "official"));
  assert.equal(official.length, 0);
  assert.equal((await db.select().from(officialAttempts)).length, 0);
});

test("a run with no recorded repository cannot be promoted either", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.update(runs).set({ repositoryId: null }).where(eq(runs.id, PRACTICE_RUN_ID));

  await assert.rejects(
    promotePracticeRun(env(binding, "fixture"), actor, PRACTICE_RUN_ID),
    (error: unknown) => error instanceof ApiHttpError && error.code === "source_changed",
  );
  assert.equal((await db.select().from(officialAttempts)).length, 0);
});

test("a renamed repository keeps the same id, so its runs stay actionable", async () => {
  // The seeded practice run records a different NAME from the team's, with the
  // same id: exactly what a rename leaves behind. It has to keep working.
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const [parent] = await db.select().from(runs).where(eq(runs.id, PRACTICE_RUN_ID));
  assert.notEqual(parent!.repositoryFullName, actor.team.repoFullName, "fixture no longer covers a rename");
  assert.equal(parent!.repositoryId, actor.team.repoId);

  const promoted = await promotePracticeRun(env(binding, "fixture"), actor, PRACTICE_RUN_ID);
  assert.ok(promoted.runId);
});

test("publishing a result from a repository the team has left is refused, and the selection stands", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const officialId = await seedOfficial(db, "succeeded");
  await db.insert(leaderboardSelections).values({
    teamId: "team_test",
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    runId: officialId,
    selectedAt: 1,
  });
  await runCameFromElsewhere(db, officialId);

  await assert.rejects(
    publishOfficialRun(env(binding, "fixture"), actor, officialId),
    (error: unknown) => error instanceof ApiHttpError && error.code === "source_changed",
  );

  // What is already published stays published. The refusal is about choosing
  // a new one, not about withdrawing the old.
  const [selection] = await db.select().from(leaderboardSelections);
  assert.equal(selection!.runId, officialId);
  assert.equal(selection!.selectedAt, 1, "the refused publication rewrote the selection");
});

test("rerunning a run from a repository the team has left is refused, with no new run", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const [parent] = await db.select().from(runs).where(eq(runs.id, PRACTICE_RUN_ID));
  await runCameFromElsewhere(db, PRACTICE_RUN_ID);
  const before = (await db.select().from(runs)).length;

  await assert.rejects(
    rerunHostedSurface(env(binding, "fixture"), actor, parent!.surfaceId!),
    (error: unknown) => error instanceof ApiHttpError && error.code === "source_changed",
  );
  assert.equal((await db.select().from(runs)).length, before, "a refused rerun still created a run");
});

test("the shared boundary refuses before it publishes anything", async () => {
  // Every client arrives here: Portal HTTP, the Activity and CogBot RPC. A
  // refusal must not reach the realtime hub, which broadcasts a snapshot and
  // can wake a Discord update.
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await runCameFromElsewhere(db, PRACTICE_RUN_ID);
  hubPublications = 0;

  for (const action of ["promote_official", "rerun_hosted"] as const) {
    await assert.rejects(
      performRunSurfaceMutation(env(binding, "fixture"), actor, SURFACE_ID, action),
      (error: unknown) => error instanceof ApiHttpError && error.code === "source_changed",
      action,
    );
  }

  assert.equal(hubPublications, 0, "a refused mutation published a snapshot");
  assert.equal((await db.select().from(officialAttempts)).length, 0);
});

test("hosted verification of a local run from another repository is refused", async () => {
  // verify_hosted resolves the local session's commit against the connected
  // repository, so it is a rerun by another name and takes the same rule.
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.insert(cliDevices).values({
    id: "device_1",
    userId: actor.userId,
    name: "laptop",
    tokenHash: "hash",
    createdAt: 1,
    expiresAt: Date.now() + 86_400_000,
    lastUsedAt: null,
    revokedAt: null,
  } as never);
  await db.insert(localRunSessions).values({
    id: "local_1",
    teamId: "team_test",
    userId: actor.userId,
    deviceId: "device_1",
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    repositoryId: FIXTURE_REPO.repositoryId + 1,
    repositoryFullName: "some-student/week3-capstone",
    sha: "c".repeat(40),
    branch: "main",
    dirty: false,
    status: "succeeded",
    phase: "complete",
    createdAt: 1,
    updatedAt: 2,
    lastEventSequence: 0,
  } as never);
  await db
    .update(runSurfaces)
    .set({ localRunId: "local_1" })
    .where(eq(runSurfaces.id, SURFACE_ID));

  await assert.rejects(
    performRunSurfaceMutation(env(binding, "fixture"), actor, SURFACE_ID, "verify_hosted"),
    (error: unknown) => error instanceof ApiHttpError && error.code === "source_changed",
  );
});

async function seedLocalSource(db: Database): Promise<void> {
  await db.insert(cliDevices).values({
    id: "device_source", userId: "user_test", name: "laptop", tokenHash: "source-hash",
    createdAt: NOW, expiresAt: NOW + 86_400_000,
  });
  await db.insert(localRunSessions).values({
    id: "local_source", teamId: "team_test", userId: "user_test", deviceId: "device_source",
    benchmarkId: BENCHMARK_ID, benchmarkVersion: 1,
    repositoryId: FIXTURE_REPO.repositoryId, repositoryFullName: "old-name/local-source",
    sha: "a".repeat(40), branch: "main", dirty: false, status: "succeeded", phase: "complete",
    createdAt: NOW, updatedAt: NOW + 1_000, finishedAt: NOW + 1_000,
  });
  await db.update(runSurfaces).set({ localRunId: "local_source" }).where(eq(runSurfaces.id, SURFACE_ID));
}

test("local-only console keeps recorded source and uses the verification refusal after a repository change", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  await seedLocalSource(db);
  await db.delete(runs).where(eq(runs.id, PRACTICE_RUN_ID));

  const matching = await buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID);
  assert.equal(matching.source?.fullName, "old-name/local-source");
  assert.equal(matching.sha, "a".repeat(40));
  assert.equal(matching.sourceRefusal, null);
  assert.ok(matching.actions.includes("verify_hosted"));

  await db.update(teams).set({ repoId: FIXTURE_REPO.repositoryId + 1 }).where(eq(teams.id, "team_test"));
  const changed = await buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID);
  assert.deepEqual(changed.source, matching.source);
  assert.match(changed.sourceRefusal ?? "", /verify it here/);
  assert.ok(!changed.actions.includes("verify_hosted"));

  await db.update(localRunSessions).set({ repositoryId: null }).where(eq(localRunSessions.id, "local_source"));
  const unknown = await buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID);
  assert.deepEqual(unknown.source, matching.source);
  assert.match(unknown.sourceRefusal ?? "", /predates/);
  assert.ok(!unknown.actions.includes("verify_hosted"));
});

test("a hosted console pairs its current stage's source and commit without borrowing local metadata", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  await seedLocalSource(db);
  // Distinct metadata makes a mixed-stage projection detectable even though
  // normal verification preserves the local commit.
  await db.update(runs).set({ sha: "b".repeat(40), branch: "hosted-branch" }).where(eq(runs.id, PRACTICE_RUN_ID));
  const snapshot = await buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID);
  assert.equal(snapshot.stage, "hosted");
  assert.equal(snapshot.source?.fullName, "some-org/the-repository-it-ran-from");
  assert.equal(snapshot.sha, "b".repeat(40));
  assert.equal(snapshot.shortSha, "b".repeat(7));
  assert.equal(snapshot.branch, "hosted-branch");
  assert.equal(snapshot.sourceRefusal, null);

  // Legacy verification accepted local sessions before their source was known.
  await db.update(localRunSessions).set({ repositoryId: null }).where(eq(localRunSessions.id, "local_source"));
  const legacyHosted = await buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID);
  assert.equal(legacyHosted.sourceRefusal, null);
  assert.ok(legacyHosted.actions.includes("promote_official"));
  assert.ok(legacyHosted.actions.includes("rerun_hosted"));
  await db.update(runs).set({ mode: "official" }).where(eq(runs.id, PRACTICE_RUN_ID));
  const legacyOfficial = await buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID);
  assert.equal(legacyOfficial.stage, "official");
  assert.equal(legacyOfficial.sourceRefusal, null);
  assert.ok(legacyOfficial.actions.includes("publish_result"));
});

test("missing hosted stages reject mutations before realtime publication", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  hubPublications = 0;
  await assert.rejects(
    performRunSurfaceMutation(env(binding, "fixture"), actor, SURFACE_ID, "publish_result"),
    (error: unknown) => error instanceof ApiHttpError && error.code === "not_selectable",
  );
  await seedLocalSource(db);
  await db.delete(runs).where(eq(runs.id, PRACTICE_RUN_ID));
  for (const [action, code] of [["promote_official", "not_promotable"], ["rerun_hosted", "not_found"], ["publish_result", "not_selectable"]] as const) {
    await assert.rejects(
      performRunSurfaceMutation(env(binding, "fixture"), actor, SURFACE_ID, action),
      (error: unknown) => error instanceof ApiHttpError && error.code === code,
    );
  }
  assert.equal(hubPublications, 0);
});

function renderDashboard(dashboard: Dashboard): string {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["benchmarks"], [dashboard.benchmark]);
  client.setQueryData(["dashboard", dashboard.benchmark.id], dashboard);
  client.setQueryData(["local-reports", dashboard.benchmark.id], []);
  client.setQueryData(["repositories"], []);
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(StaticRouter, { location: "/dashboard" }, React.createElement(DashboardPage))));
}

test("dashboard API and rendered candidate agree with detail for unknown, changed and renamed sources", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.update(benchmarks).set({ active: false }).where(and(eq(benchmarks.id, BENCHMARK_ID), ne(benchmarks.version, 1)));
  await db.insert(runMetrics).values({ runId: PRACTICE_RUN_ID, key: "accuracy", label: "Accuracy",
    value: 0.8, unit: null, higherIsBetter: true, isPrimary: true, precision: 2 });
  const testEnv = { ...env(binding, "modal"), DEV_AUTH: "enabled" as const,
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars", BETTER_AUTH_URL: "http://localhost:5173" };
  const signedIn = await createAuth(testEnv).api.signUpEmail({
    body: { email: "dashboard-source@example.test", password: "cogportal-local-dev-password", name: "Source reader" },
    returnHeaders: true,
  });
  await db.insert(teamMembers).values({ teamId: actor.team.id, userId: signedIn.response.user.id, role: "admin" });
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const app = new Hono<AppEnv>();
  registerDashboardRoutes(app);
  for (const repositoryId of [null, FIXTURE_REPO.repositoryId + 1, FIXTURE_REPO.repositoryId]) {
    await db.update(runs).set({ repositoryId }).where(eq(runs.id, PRACTICE_RUN_ID));
    const response = await app.fetch(new Request(`http://localhost:5173/dashboard?benchmark=${BENCHMARK_ID}`, { headers: { cookie } }), testEnv);
    assert.equal(response.status, 200);
    const dashboard = DashboardSchema.parse(await response.json());
    const [row] = await db.select().from(runs).where(eq(runs.id, PRACTICE_RUN_ID));
    assert.ok(row);
    const detail = await serializeRunDetail(db, row, actor.team);
    assert.equal(dashboard.latestCandidate?.id, PRACTICE_RUN_ID);
    assert.equal(dashboard.latestCandidate?.sourceRefusal, detail.sourceRefusal);
    assert.equal(dashboard.latestCandidate?.repo?.fullName, "some-org/the-repository-it-ran-from");
    const html = renderDashboard(dashboard);
    if (repositoryId === FIXTURE_REPO.repositoryId) {
      assert.equal(dashboard.latestCandidate?.sourceRefusal, null, "a same-ID rename remains eligible");
      assert.match(html, /Candidate ready/);
      assert.match(html, /Promote to official/);
      assert.match(renderDashboard({ ...dashboard, quota: { ...dashboard.quota, officialUsed: dashboard.quota.officialLimit } }), /disabled=""[^>]*>Promote to official/);
    } else {
      assert.match(html, /Previous result/);
      assert.ok(detail.sourceRefusal);
      assert.ok(html.includes(detail.sourceRefusal));
      assert.doesNotMatch(html, /Promote to official/);
      assert.doesNotMatch(html, /Candidate ready/);
    }
  }
  await db.update(runs).set({ mode: "official", attemptNumber: 1 }).where(eq(runs.id, PRACTICE_RUN_ID));
  await db.insert(leaderboardSelections).values({
    teamId: actor.team.id, benchmarkId: BENCHMARK_ID, benchmarkVersion: 1,
    runId: PRACTICE_RUN_ID, selectedAt: NOW,
  });
  const response = await app.fetch(new Request(`http://localhost:5173/dashboard?benchmark=${BENCHMARK_ID}`, { headers: { cookie } }), testEnv);
  assert.equal(response.status, 200);
  const published = DashboardSchema.parse(await response.json());
  assert.equal(published.selection?.source?.fullName, "some-org/the-repository-it-ran-from");
  assert.equal(published.selection?.runId, PRACTICE_RUN_ID);
  assert.match(renderDashboard(published), /PUBLISHED RESULT[\s\S]*some-org\/the-repository-it-ran-from/);

  const firstRun = renderDashboard({
    ...published,
    benchmark: { ...published.benchmark, id: "language-search", title: "Semantic Image Search", module: "language" },
    runs: [], latestCandidate: null, selection: null,
    quota: { ...published.quota, practiceUsed: 0, officialUsed: 0 },
  });
  assert.match(firstRun, /FIRST RUN/);
  // Grid items must shrink so Code scrolls internally instead of widening the page.
  assert.match(firstRun, /<div class="min-w-0"><h3 class="u-kicker">On your machine/);
  assert.match(firstRun, /<div class="min-w-0"><h3 class="u-kicker">Here, from your pushed commit/);
  assert.match(firstRun, /class="code-block /);
  assert.match(firstRun, /cogworks check --benchmark language-search\ncogworks run --benchmark language-search\ncogworks sync/);
  assert.match(firstRun, /<select[^>]*>[\s\S]*main/);
});

test("the rule answers every combination of missing and differing ids", () => {
  const team = { repoId: 7, repoFullName: "owner/connected" };
  assert.equal(runSourceRefusal(team, { repositoryId: 7 }, "act"), null);
  assert.match(runSourceRefusal(team, { repositoryId: 8 }, "act") ?? "", /no longer connected/);
  assert.match(runSourceRefusal(team, { repositoryId: null }, "act") ?? "", /predates/);
  assert.match(runSourceRefusal(team, null, "act") ?? "", /predates/);
  // A team with no recorded repository cannot authorise anything against one.
  const unknownTeam = { repoId: null, repoFullName: "owner/connected" };
  assert.match(runSourceRefusal(unknownTeam, { repositoryId: 7 }, "act") ?? "", /no longer connected/);
  assert.match(runSourceRefusal(unknownTeam, { repositoryId: null }, "act") ?? "", /predates/);
});
