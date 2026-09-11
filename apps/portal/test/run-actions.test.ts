import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";
import { buildRunSurfaceSnapshot } from "../worker/services/run-surfaces.ts";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { DashboardSchema, RunDetailSchema, RUN_PHASES } from "@cogworks/contracts/schema";
import { insertRunWithCapacity, readRunAccounting } from "../worker/services/run-accounting.ts";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  officialAttempts,
  localReports,
  leaderboardSelections,
  teamMembers,
  runs,
  runPhases,
  runSurfaces,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { ApiHttpError, handleError } from "../worker/http/errors.ts";
import { createAuth } from "../worker/auth/better-auth.ts";
import { registerRunRoutes } from "../worker/routes/runs.ts";
import { registerDashboardRoutes } from "../worker/routes/dashboard.ts";
import { savedEnvironmentEligibility } from "../worker/services/run-eligibility.ts";
import { PreparedEnvironmentV1Schema, RunJobV1Schema } from "@cogworks/contracts/protocol";
import {
  promotePracticeRun,
  publishOfficialRun,
  startPracticeRun,
  rerunHostedSurface,
  retryRun,
  performRunSurfaceMutation,
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
const PREPARED = {
  ...PreparedEnvironmentV1Schema.parse(JSON.parse(readFileSync(new URL("../../../protocols/v1/fixtures/prepared-environment.valid.json", import.meta.url), "utf8"))),
  source: { repositoryId: FIXTURE_REPO.repositoryId, fullName: FIXTURE_REPO.fullName, sha: "a".repeat(40) },
};

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
      run() {
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
    // admission rollback is exercised, not stubbed.
    async batch(statements: Array<{ run(): unknown }>) {
      sqlite.exec("BEGIN");
      try {
        // Execute without yielding, matching D1's serialized transaction writes.
        const results = [];
        for (const statement of statements) results.push(statement.run());
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
    // A promotion that reaches the end publishes the run surface. Until a
    // dispatch could survive its own rejection, no test here got that far.
    RUN_SURFACES: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
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
    sandboxContract: 1,
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
    preparedEnvironmentJson: JSON.stringify(PREPARED),
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

for (const mode of ["practice", "official"] as const) {
  test(`${mode} Retry keeps its console and inputs, with one successor per failed execution`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    const failedId = mode === "official" ? await seedOfficial(db, "failed") : PRACTICE_RUN_ID;
    await db.update(runs).set({
      status: "failed", provider: "fixture", finishedAt: NOW + 2_000,
      failureCategory: "student_runtime", failureDetail: "Original failure", diagnosticsJson: '["old finding"]',
    }).where(eq(runs.id, failedId));
    const before = await buildRunSurfaceSnapshot(env(binding, "fixture"), SURFACE_ID);
    assert.ok(before.actions.includes("retry"));
    const snapshots = await Promise.all(Array.from({ length: 4 }, () => performRunSurfaceMutation(
      env(binding, "fixture"), actor, SURFACE_ID, "retry", { runId: failedId },
    )));
    const successors = await db.select().from(runs).where(eq(runs.retryOfRunId, failedId));
    assert.equal(successors.length, 1);
    const next = successors[0];
    assert.ok(next);
    assert.equal(next.mode, mode);
    assert.equal(next.surfaceId, SURFACE_ID);
    assert.equal(next.sha, "a".repeat(40));
    assert.equal(next.repositoryId, FIXTURE_REPO.repositoryId);
    assert.equal(next.parentRunId, mode === "official" ? PRACTICE_RUN_ID : null);
    assert.equal(next.failureCategory, null);
    assert.equal(next.diagnosticsJson, null);
    assert.equal(next.refundedAt, null);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.id, SURFACE_ID);
      assert.equal(mode === "official" ? snapshot.officialRunId : snapshot.practiceRunId, next.id);
      assert.equal(snapshot.executionGeneration, before.executionGeneration + 1);
      assert.equal(snapshot.actions.includes("retry"), false);
      assert.equal(snapshot.executionHistory.find((run) => run.id === failedId)?.status, "failed");
    }
    if (mode === "official") {
      assert.equal(next.attemptNumber, 1);
    }
    await db.update(runs).set({ status: "failed", finishedAt: Date.now() }).where(eq(runs.id, next.id));
    await retryRun(env(binding, "fixture"), actor, SURFACE_ID, failedId);
    assert.equal((await db.select().from(runs).where(eq(runs.surfaceId, SURFACE_ID))).length, before.executionGeneration + 1);
    await retryRun(env(binding, "fixture"), actor, SURFACE_ID, next.id);
    const [last] = await db.select().from(runs).where(eq(runs.retryOfRunId, next.id));
    assert.ok(last);
    await db.update(runs).set({ status: "succeeded", finishedAt: Date.now() }).where(eq(runs.id, last.id));
    const accounting = await readRunAccounting(db, {
      teamId: actor.team.id, benchmarkId: BENCHMARK_ID, benchmarkVersion: 1,
    });
    assert.equal(mode === "official" ? accounting.officialUsed : accounting.practiceUsed, 1);
    const final = await buildRunSurfaceSnapshot(env(binding, "fixture"), SURFACE_ID);
    assert.equal(mode === "official" ? final.officialRunId : final.practiceRunId, last.id);
    assert.equal(final.status, "succeeded");
    const [original] = await db.select().from(runs).where(eq(runs.id, failedId));
    assert.equal(original?.status, "failed");
    assert.equal(original?.failureDetail, "Original failure");
  });
}

for (const mode of ["practice", "official"] as const) {
  test(`${mode} Retry cannot exceed completed quota or displace another active execution`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    const failedId = mode === "official" ? await seedOfficial(db, "failed") : PRACTICE_RUN_ID;
    await db.update(runs).set({ status: "failed", provider: "fixture" }).where(eq(runs.id, failedId));
    const [failed] = await db.select().from(runs).where(eq(runs.id, failedId));
    assert.ok(failed);
    const competitor = { ...failed, id: "run_other_candidate", status: "queued" as const, createdAt: Date.now(), finishedAt: null, surfaceId: null, benchmarkVersion: 99 };
    const raced = await Promise.allSettled([
      retryRun(env(binding, "fixture"), actor, SURFACE_ID, failedId),
      insertRunWithCapacity(db, competitor),
    ]);
    const active = (await db.select().from(runs)).filter((run) => RUN_PHASES.some((phase) => phase === run.status));
    assert.equal(active.length, 1);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    const admitted = active[0];
    assert.ok(admitted);
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, admitted.id));
    // Use a fresh failure when Retry won the race, so this is admission, not replay.
    const target = admitted.retryOfRunId === failedId ? admitted.id : failedId;
    for (let index = 0; index < (mode === "official" ? 3 : 10); index += 1) {
      await db.insert(runs).values({
        ...failed, id: `run_completed_${index}`, status: "succeeded", refundedAt: null,
        surfaceId: null, finishedAt: NOW + 1_000,
      });
    }
    await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, target), /quota is exhausted/);
    assert.equal((await db.select().from(runs).where(eq(runs.retryOfRunId, target))).length, 0);
  });
}

test("Retry refuses changed provider, repository, configuration, and nonfailed executions", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, PRACTICE_RUN_ID), /Only a failed/);
  await db.update(runs).set({ status: "failed" }).where(eq(runs.id, PRACTICE_RUN_ID));
  await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, PRACTICE_RUN_ID), /source is no longer/);
  await db.update(runs).set({ provider: "fixture", repositoryId: 999 }).where(eq(runs.id, PRACTICE_RUN_ID));
  await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, PRACTICE_RUN_ID), /source is no longer/);
  await db.update(runs).set({ repositoryId: FIXTURE_REPO.repositoryId, scorerVersion: "changed" }).where(eq(runs.id, PRACTICE_RUN_ID));
  await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, PRACTICE_RUN_ID), /configuration has changed/);
  assert.equal((await db.select().from(runs)).length, 1);
});

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

async function authenticatedPromotion(db: Database, binding: unknown) {
  const runtime: Env = {
    ...env(binding, "modal"),
    DEV_AUTH: "enabled",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
  };
  const signIn = await createAuth(runtime).api.signUpEmail({
    body: { email: "promotion@example.test", password: "cogportal-local-dev-password", name: "Promotion" },
    returnHeaders: true,
  });
  await db.insert(teamMembers).values({ teamId: "team_test", userId: signIn.response.user.id, role: "write", joinedAt: NOW });
  const cookie = signIn.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
  const app = new Hono<AppEnv>();
  registerRunRoutes(app);
  registerDashboardRoutes(app);
  registerRunnerEventRoutes(app);
  app.onError(handleError);
  return { runtime, app, cookie, promote: (authenticated = true) => app.fetch(new Request(`http://localhost:5173/runs/${PRACTICE_RUN_ID}/promote`, {
    method: "POST", headers: authenticated ? { cookie } : {},
  }), runtime) };
}

test("a null catalog sandbox contract pauses hosted practice before inserting an execution", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.update(benchmarks).set({ sandboxContract: null }).where(eq(benchmarks.id, BENCHMARK_ID));
  const before = await db.select().from(runs);
  const surfacesBefore = await db.select().from(runSurfaces);
  await assert.rejects(startPracticeRun(env(binding, "modal"), actor, { benchmarkId: BENCHMARK_ID, branch: "main" }),
    (error: unknown) => {
      assert.ok(error instanceof ApiHttpError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "not_promotable");
      assert.equal(error.message, "This benchmark's hosted environment is not ready.");
      return true;
    });
  assert.deepEqual(await db.select().from(runs), before);
  assert.deepEqual(await db.select().from(runSurfaces), surfacesBefore);
});

for (const proof of ["compatible", "missing", "tampered"] as const) {
  test(`${proof} saved evidence has one refusal across the surface, dashboard and run detail without changing success`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    // The fixture run is v1; migrations also seed an active Vision v2 row.
    await db.update(benchmarks).set({ active: false }).where(and(eq(benchmarks.id, BENCHMARK_ID), sql`${benchmarks.version} <> 1`));
    const preparedEnvironmentJson = proof === "missing" ? null : JSON.stringify({
      ...PREPARED, ...(proof === "tampered" ? { artifactId: "another-snapshot" } : {}),
    });
    await db.update(runs).set({ preparedEnvironmentJson }).where(eq(runs.id, PRACTICE_RUN_ID));
    const [before] = await db.select().from(runs).where(eq(runs.id, PRACTICE_RUN_ID));
    const [benchmark] = await db.select().from(benchmarks).where(eq(benchmarks.id, BENCHMARK_ID));
    const eligibility = savedEnvironmentEligibility(before, benchmark, actor.team.repoFullName);
    assert.equal(eligibility.eligible, proof === "compatible");
    const expectedReason = eligibility.eligible ? null : eligibility.reason;
    const { app, runtime, cookie } = await authenticatedPromotion(db, binding);
    const snapshot = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
    assert.equal(snapshot.status, "succeeded");
    assert.equal(snapshot.promotionRefusal, expectedReason);
    assert.equal(snapshot.actions.includes("promote_official"), proof === "compatible");

    const dashboardResponse = await app.fetch(new Request(`http://localhost:5173/dashboard?benchmark=${BENCHMARK_ID}`, { headers: { cookie } }), runtime);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = DashboardSchema.parse(await dashboardResponse.json());
    assert.equal(dashboard.latestCandidate?.id, PRACTICE_RUN_ID);
    assert.equal(dashboard.latestCandidate?.status, "succeeded");
    assert.equal(dashboard.promotionRefusal, expectedReason);

    const detailResponse = await app.fetch(new Request(`http://localhost:5173/runs/${PRACTICE_RUN_ID}`, { headers: { cookie } }), runtime);
    assert.equal(detailResponse.status, 200);
    const detail = RunDetailSchema.parse(await detailResponse.json());
    assert.equal(detail.status, "succeeded");
    assert.equal(detail.promotionRefusal, expectedReason);
    const [after] = await db.select().from(runs).where(eq(runs.id, PRACTICE_RUN_ID));
    assert.deepEqual(after, before);

    assert.equal(DashboardSchema.parse({ ...dashboard, promotionRefusal: undefined }).promotionRefusal, null);
    assert.equal(RunDetailSchema.parse({ ...detail, promotionRefusal: undefined }).promotionRefusal, null);
  });
}

test("authenticated completion, promotion and signed dispatch preserve provisioning across a scorer change", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  const { runtime, app, promote } = await authenticatedPromotion(db, binding);
  await db.update(runs).set({ status: "scoring", createdAt: Date.now(), finishedAt: null, preparedArtifactId: null, preparedEnvironmentJson: null }).where(eq(runs.id, PRACTICE_RUN_ID));
  const event = {
    protocolVersion: "1", type: "completed", eventId: "evt_prepared", runId: PRACTICE_RUN_ID,
    sequence: 5, occurredAt: Date.now(), preparedArtifactId: PREPARED.artifactId,
    preparedEnvironment: PREPARED, environmentDigest: "b".repeat(64), sanitizedLog: null,
    result: { protocolVersion: "1", benchmarkId: BENCHMARK_ID, benchmarkVersion: 1,
      metrics: [{ key: "accuracy", label: "Accuracy", value: 0.5, unit: null, higherIsBetter: true, primary: true, precision: 2 }],
      diagnostics: [], outputDigest: "c".repeat(64) },
  };
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const callback = await app.fetch(new Request("http://localhost:5173/internal/v1/runner/events", {
    method: "POST", body, headers: { "X-Cogworks-Key-Id": "runner-v1", "X-Cogworks-Timestamp": timestamp,
      "X-Cogworks-Signature": `v1=${await hmacSignature(runtime.RUNNER_SIGNING_SECRET!, timestamp, body)}` },
  }), runtime);
  assert.equal(callback.status, 200, await callback.text());
  await db.update(benchmarks).set({ scorerVersion: "new-scorer", runtimeVersion: "new-runtime-label" }).where(eq(benchmarks.id, BENCHMARK_ID));
  assert.equal((await promote(false)).status, 401);
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (_input, init) => {
    const payload = String(init?.body);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Cogworks-Signature"), `v1=${await hmacSignature(runtime.RUNNER_SIGNING_SECRET!, headers.get("X-Cogworks-Timestamp")!, payload)}`);
    const job = RunJobV1Schema.parse(JSON.parse(payload));
    assert.deepEqual(job.preparedEnvironment, PREPARED);
    assert.equal(job.benchmark.sandboxContract, 1);
    assert.equal(job.benchmark.scorerVersion, "new-scorer");
    assert.equal(job.preparedArtifactId, PREPARED.artifactId);
    assert.equal(job.weights, undefined);
    sent++;
    return new Response(null, { status: 202 });
  };
  try {
    const response = await promote();
    assert.equal(response.status, 201, await response.text());
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(sent, 1);
  const [official] = await db.select().from(runs).where(eq(runs.mode, "official"));
  assert.deepEqual(JSON.parse(official.preparedEnvironmentJson!), PREPARED);
  assert.equal(official.scorerVersion, "new-scorer");
});

for (const [name, patch] of Object.entries({
  legacy: { preparedEnvironmentJson: null },
  malformed: { preparedEnvironmentJson: "{" },
  artifact: { preparedEnvironmentJson: JSON.stringify({ ...PREPARED, artifactId: "another-artifact" }) },
  benchmark: { preparedEnvironmentJson: JSON.stringify({ ...PREPARED, benchmarkId: "language-search" }) },
  source: { preparedEnvironmentJson: JSON.stringify({ ...PREPARED, source: { ...PREPARED.source, sha: "b".repeat(40) } }) },
  repository: { preparedEnvironmentJson: JSON.stringify({ ...PREPARED, source: { ...PREPARED.source, repositoryId: 999 } }) },
  contract: { preparedEnvironmentJson: JSON.stringify({ ...PREPARED, sandboxContract: 2 }) },
})) {
  test(`authenticated promotion refuses ${name} evidence before admission`, async () => {
    const { db, binding } = freshDb();
    await seedPromotion(db);
    await db.update(runs).set(patch).where(eq(runs.id, PRACTICE_RUN_ID));
    const { promote } = await authenticatedPromotion(db, binding);
    const response = await promote();
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "not_promotable");
    assert.equal((await db.select().from(runs)).length, 1);
    const accounting = await readRunAccounting(db, { teamId: "team_test", benchmarkId: BENCHMARK_ID, benchmarkVersion: 1 });
    assert.equal(accounting.officialUsed, 0);
    assert.equal(accounting.officialReserved, 0);
  });
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

test("a reaped official result that arrives late offers a fresh hosted run instead of re-promotion", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const officialId = await seedOfficial(db, "succeeded");
  await db.update(runs).set({ status: "evaluating", finishedAt: null }).where(eq(runs.id, officialId));
  const runtime = env(binding, "modal");
  await maintainPlatform(runtime, NOW + 3_601_001);
  const [reaped] = await db.select().from(runs).where(eq(runs.id, officialId));
  assert.equal(reaped.status, "failed");
  assert.equal(reaped.refundedAt, null);

  const app = new Hono<AppEnv>();
  registerRunnerEventRoutes(app);
  const body = JSON.stringify({
    protocolVersion: "1",
    eventId: "event_late_official",
    runId: officialId,
    sequence: 5,
    occurredAt: NOW + 60_000,
    type: "completed",
    preparedArtifactId: "artifact_test",
    environmentDigest: "b".repeat(64),
    sanitizedLog: null,
    result: {
      protocolVersion: "1",
      benchmarkId: BENCHMARK_ID,
      benchmarkVersion: 1,
      metrics: [{ key: "accuracy", label: "Accuracy", value: 0.5, unit: null, higherIsBetter: true, primary: true, precision: 3 }],
      diagnostics: ["The image stage returned no embeddings."],
      outputDigest: "c".repeat(64),
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const response = await app.fetch(new Request("https://portal.example/internal/v1/runner/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Cogworks-Key-Id": "runner-v1",
      "X-Cogworks-Timestamp": timestamp,
      "X-Cogworks-Signature": `v1=${await hmacSignature(runtime.RUNNER_SIGNING_SECRET!, timestamp, body)}`,
    },
    body,
  }), runtime);
  assert.equal(response.status, 200, await response.text());
  const [recovered] = await db.select().from(runs).where(eq(runs.id, officialId));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.finishedAt, reaped.finishedAt);
  assert.equal(recovered.failureDetail, reaped.failureDetail);
  assert.equal(recovered.refundedAt, reaped.refundedAt);
  assert.match(recovered.diagnosticsJson!, /image stage/);
  await assert.rejects(promotePracticeRun(runtime, actor, PRACTICE_RUN_ID), (error: unknown) => {
    assert.ok(error instanceof ApiHttpError);
    assert.equal(error.code, "not_promotable");
    assert.match(error.message, /already ran and failed.*Start a new practice run/);
    return true;
  });
  const snapshot = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  assert.equal(snapshot.status, "failed");
  assert.ok(snapshot.actions.includes("rerun_hosted"));
  assert.ok(!snapshot.actions.includes("publish_result"));
  assert.ok(!snapshot.actions.includes("promote_official"));
  const rerun = await rerunHostedSurface(env(binding, "fixture"), actor, SURFACE_ID);
  assert.notEqual(rerun.surfaceId, SURFACE_ID);
  const [successor] = await db.select().from(runSurfaces).where(eq(runSurfaces.id, rerun.surfaceId));
  assert.equal(successor.supersedesSurfaceId, SURFACE_ID);
});

test("incomplete weight uploads fail hosted dispatch without leaving an active run", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.insert(teamMembers).values({ teamId: actor.team.id, userId: actor.userId, role: "write" });
  await db.insert(localReports).values({
    reportId: "report_missing_weight",
    userId: actor.userId,
    benchmarkId: BENCHMARK_ID,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    sdkVersion: "0.2.0",
    pluginVersion: "1",
    repositoryFullName: FIXTURE_REPO.fullName,
    sha: "a".repeat(40),
    dirty: false,
    startedAt: NOW,
    finishedAt: NOW + 1_000,
    metricsJson: "[]",
    diagnosticsJson: "[]",
    weightsUsedJson: '["models/first.pkl","models/missing.pkl"]',
    weightsUploadedJson: JSON.stringify([
      { path: "models/first.pkl", sha256: "0".repeat(64) },
      { path: "models/missing.pkl", sha256: "0".repeat(64) },
    ]),
    syncedAt: NOW + 2_000,
  });
  let sent = 0;
  const checked: string[] = [];
  const runtime = env(binding, "modal", { async send() { sent += 1; } });
  // SAFETY: dispatch only reads head(). No upload or other R2 operation runs here.
  runtime.ARTIFACTS = {
    async head(key: string) {
      checked.push(key);
      return key.endsWith("first.pkl")
        ? { size: 3, checksums: { sha256: new Uint8Array(32).buffer } }
        : null;
    },
  } as unknown as R2Bucket;

  // Official promotion reuses a prepared artifact; new hosted practice is
  // the owning path that assembles uploaded weights before enqueueing.
  for (let retry = 0; retry < 2; retry += 1) {
    await assert.rejects(startPracticeRun(runtime, actor, {
      benchmarkId: BENCHMARK_ID,
      exactSha: "a".repeat(40),
    }), {
      code: "invalid_request",
      status: 409,
      message: "Required weight models/missing.pkl has not been uploaded; sync the report again.",
    });
  }
  assert.equal(sent, 0);
  assert.equal(checked.length, 4);
  assert.ok(checked[1].endsWith("models/missing.pkl"));
  const failed = (await db.select().from(runs)).filter((run) => run.id !== PRACTICE_RUN_ID);
  assert.equal(failed.length, 2, "retry was not blocked by an active-run row");
  for (const run of failed) {
    assert.equal(run.status, "failed");
    assert.equal(run.failureCategory, "provider");
    assert.equal(run.failurePhase, "queued");
    assert.equal(run.failureDetail, "Required weight models/missing.pkl has not been uploaded; sync the report again.");
    assert.equal(run.failureConsumedAttempt, false);
    assert.notEqual(run.finishedAt, null);
    assert.equal(run.lastEventSequence, -1);
  }
});

test("an official dispatch failure releases capacity", async () => {
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

  const [official] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.parentRunId, PRACTICE_RUN_ID), eq(runs.mode, "official")));
  assert.ok(official);
  assert.equal(official.status, "failed");
  assert.equal(official.failureCategory, "provider");
  assert.equal((await readRunAccounting(db, ACCOUNTING_SCOPE)).officialReserved, 0);
});

for (const status of [400, 401, 502, 503, 200, 302, 202]) {
  test(`direct Modal dispatch returning ${status} ${status >= 400 && status < 500 ? "fails the run and releases capacity" : "keeps the queued reservation"}`, async () => {
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
      assert.equal((await readRunAccounting(db, ACCOUNTING_SCOPE)).officialReserved, rejected ? 0 : 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const callbackLanded of [false, true]) {
  test(`a direct Modal network error keeps the ${callbackLanded ? "callback's preparing" : "queued"} reservation`, async () => {
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
});

test("dispatch failure remains terminal and blocks same-surface re-promotion", async () => {
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
  assert.equal(official?.status, "failed");
  assert.equal((await readRunAccounting(db, ACCOUNTING_SCOPE)).officialReserved, 0);
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

const ACCOUNTING_SCOPE = { teamId: "team_test", benchmarkId: BENCHMARK_ID, benchmarkVersion: 1 };

async function historyRun(db: Database, id: string, overrides: Partial<typeof runs.$inferInsert> = {}) {
  const [parent] = await db.select().from(runs).where(eq(runs.id, PRACTICE_RUN_ID));
  const row = { ...parent, id, surfaceId: null, ...overrides };
  await db.insert(runs).values(row);
  return row;
}

test("durable successes alone count, with version and team scope and separate active reservations", async () => {
  const { db } = freshDb();
  const actor = await seedPromotion(db);
  for (const mode of ["practice", "official"] as const) {
    await historyRun(db, `${mode}_accepted`, { mode, status: "succeeded" });
    await historyRun(db, `${mode}_refunded_success`, { mode, status: "succeeded", refundedAt: NOW });
    await historyRun(db, `${mode}_cancelled`, { mode, status: "cancelled" });
    for (const failureCategory of ["provider", "student_runtime", "timeout", "output_invalid", "scorer"] as const) {
      await historyRun(db, `${mode}_${failureCategory}`, {
        mode, status: "failed", failureCategory, failurePhase: "evaluating", failureConsumedAttempt: true,
      });
    }
    await historyRun(db, `${mode}_other_version`, { mode, benchmarkVersion: 2 });
    await historyRun(db, `${mode}_other_benchmark`, { mode, benchmarkId: "another-benchmark" });
  }
  await db.insert(teams).values({ ...actor.team, id: "other_team", repoFullName: "other/repo" });
  await historyRun(db, "other_team_success", { teamId: "other_team", mode: "official" });
  // Old consumed claims are deliberately inconsistent with the durable runs.
  await db.insert(officialAttempts).values({
    id: "stale_claim", ...ACCOUNTING_SCOPE, runId: "official_student_runtime",
    attemptNumber: 3, consumed: true, claimedAt: NOW,
  });
  assert.deepEqual(await readRunAccounting(db, ACCOUNTING_SCOPE), {
    practiceUsed: 2, officialUsed: 1, practiceReserved: 0, officialReserved: 0, activeRuns: 0,
  });
  assert.deepEqual(await readRunAccounting(db, { teamId: actor.team.id, allBenchmarks: true }), {
    practiceUsed: 4, officialUsed: 3, practiceReserved: 0, officialReserved: 0, activeRuns: 0,
  });
  await historyRun(db, "active", { status: "queued", finishedAt: null });
  for (const mode of ["practice", "official"] as const) {
    for (const status of RUN_PHASES) {
      await db.update(runs).set({ mode, status }).where(eq(runs.id, "active"));
      assert.deepEqual(await readRunAccounting(db, ACCOUNTING_SCOPE), {
        practiceUsed: 2, officialUsed: 1,
        practiceReserved: Number(mode === "practice"), officialReserved: Number(mode === "official"), activeRuns: 1,
      });
    }
  }
  await db.update(runs).set({ benchmarkVersion: 2 }).where(eq(runs.id, "active"));
  assert.deepEqual(await readRunAccounting(db, ACCOUNTING_SCOPE), {
    practiceUsed: 2, officialUsed: 1, practiceReserved: 0, officialReserved: 0, activeRuns: 1,
  });
});

for (const mode of ["practice", "official"] as const) {
  test(`${mode} conditional admission rechecks capacity after a stale read and excludes failures`, async () => {
    const { db } = freshDb();
    await seedPromotion(db);
    const limit = mode === "practice" ? 10 : 3;
    await db.update(runs).set({ mode }).where(eq(runs.id, PRACTICE_RUN_ID));
    for (let i = 1; i < limit - 1; i++) await historyRun(db, `accepted_${i}`, { mode });
    const before = await readRunAccounting(db, ACCOUNTING_SCOPE);
    assert.equal(before[mode === "practice" ? "practiceUsed" : "officialUsed"], limit - 1);
    const last = await historyRun(db, "last_completed", { mode });
    const pending = { ...last, id: "new_execution", status: "queued" as const, finishedAt: null };
    assert.equal((await insertRunWithCapacity(db, pending)).meta.changes, 0);
    // The same slot is reserved while the last execution is active, never used.
    await db.update(runs).set({ status: "evaluating" }).where(eq(runs.id, last.id));
    assert.equal((await insertRunWithCapacity(db, pending)).meta.changes, 0);
    await db.update(runs).set({ status: "failed", failureConsumedAttempt: true }).where(eq(runs.id, last.id));
    assert.equal((await insertRunWithCapacity(db, pending)).meta.changes, 1);
    const counts = await readRunAccounting(db, ACCOUNTING_SCOPE);
    assert.equal(counts[mode === "practice" ? "practiceUsed" : "officialUsed"], limit - 1);
    assert.equal(counts[mode === "practice" ? "practiceReserved" : "officialReserved"], 1);
  });
}

test("concurrent practice starts admit only one execution at the last available slot", async () => {
  const { db, binding } = freshDb();
  // Catalog migrations seed a newer version; this test targets version 1.
  await db.update(benchmarks).set({ active: false });
  const actor = await seedPromotion(db);
  for (let i = 1; i < 9; i++) await historyRun(db, `practice_${i}`);
  const results = await Promise.allSettled([1, 2].map(() => startPracticeRun(env(binding, "fixture"), actor, {
    benchmarkId: BENCHMARK_ID, exactSha: "a".repeat(40),
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const active = (await db.select().from(runs)).find((run) => run.status === "queued");
  assert.equal(active?.benchmarkVersion, 1, JSON.stringify(active));
  assert.deepEqual(await readRunAccounting(db, ACCOUNTING_SCOPE), {
    practiceUsed: 9, officialUsed: 0, practiceReserved: 1, officialReserved: 0, activeRuns: 1,
  });
});

test("legacy failed claims cannot block concurrent promotion into the last official slot", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  for (let i = 1; i <= 2; i++) await historyRun(db, `accepted_${i}`, { mode: "official" });
  for (let i = 1; i <= 3; i++) {
    await historyRun(db, `failed_${i}`, { mode: "official", status: "failed" });
    await db.insert(officialAttempts).values({
      id: `claim_${i}`, ...ACCOUNTING_SCOPE, runId: `failed_${i}`, attemptNumber: i, consumed: true, claimedAt: NOW,
    });
  }
  const secondSurface = "surface_11111111111111111111";
  const [surface] = await db.select().from(runSurfaces).where(eq(runSurfaces.id, SURFACE_ID));
  await db.insert(runSurfaces).values({ ...surface, id: secondSurface });
  await historyRun(db, "practice_second", { surfaceId: secondSurface });
  const runtime = env(binding, "modal", { async send() {} });
  const results = await Promise.allSettled([PRACTICE_RUN_ID, "practice_second"].map((id) => promotePracticeRun(runtime, actor, id)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const [active] = (await db.select().from(runs)).filter((run) => run.status === "queued");
  assert.equal(active.attemptNumber, 3, "visible attempt number follows completed evaluations");
  assert.equal((await db.select().from(runPhases).where(eq(runPhases.runId, active.id))).length, RUN_PHASES.length);
  assert.deepEqual(await readRunAccounting(db, ACCOUNTING_SCOPE), {
    practiceUsed: 2, officialUsed: 2, practiceReserved: 0, officialReserved: 1, activeRuns: 1,
  });
});

for (const admission of ["promotion", "practice Retry", "official Retry"] as const) {
  test(`${admission} phase failure rolls back admission before dispatch`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    const failedId = admission === "official Retry" ? await seedOfficial(db, "failed") : PRACTICE_RUN_ID;
    if (admission !== "promotion") {
      await db.update(runs).set({ status: "failed", provider: "fixture" }).where(eq(runs.id, failedId));
    }
    const before = await db.select().from(runs);
    const surfaces = await db.select().from(runSurfaces);
    // Fail after earlier phase inserts to prove the whole admission rolls back.
    await db.run(sql`
      CREATE TRIGGER reject_test_phase BEFORE INSERT ON run_phases
      WHEN NEW.phase = 'evaluating'
      BEGIN SELECT RAISE(ABORT, 'test phase write failure'); END
    `);
    let dispatched = 0;
    const runtime = env(binding, admission === "promotion" ? "modal" : "fixture", {
      async send() { dispatched += 1; },
    });
    const admit = () => admission === "promotion"
      ? promotePracticeRun(runtime, actor, PRACTICE_RUN_ID)
      : retryRun(runtime, actor, SURFACE_ID, failedId);
    await assert.rejects(admit(), /test phase write failure/);
    assert.deepEqual(await db.select().from(runs), before);
    assert.deepEqual(await db.select().from(runSurfaces), surfaces);
    assert.deepEqual(await db.select().from(runPhases), []);
    assert.equal(dispatched, 0);
    await db.run(sql`DROP TRIGGER reject_test_phase`);
    await admit();
    assert.equal((await db.select().from(runs)).length, before.length + 1);
    assert.equal((await db.select().from(runPhases)).length, RUN_PHASES.length);
  });
}

test("historical refunded success stays uncharged and unpublished despite a surviving claim and selection", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const runId = await seedOfficial(db, "succeeded");
  await db.update(runs).set({ refundedAt: NOW }).where(eq(runs.id, runId));
  await db.insert(leaderboardSelections).values({ ...ACCOUNTING_SCOPE, runId, selectedAt: NOW });
  const runtime = env(binding, "modal");
  assert.equal((await readRunAccounting(db, ACCOUNTING_SCOPE)).officialUsed, 0);
  const snapshot = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  assert.equal(snapshot.status, "succeeded", "historical state remains readable");
  assert.equal(snapshot.published, false);
  assert.equal(snapshot.nextOfficialAttempt, 1);
  assert.ok(!snapshot.actions.includes("publish_result"));
  await assert.rejects(publishOfficialRun(runtime, actor, runId), { code: "not_selectable" });
  await assert.rejects(promotePracticeRun(runtime, actor, PRACTICE_RUN_ID), { code: "not_promotable" });
});

for (const successSlot of [1, 3]) {
  test(`promotion numbers by accepted count despite historical attempt ${successSlot}`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    for (let slot = 1; slot <= 3; slot++) {
      const accepted = slot === successSlot;
      await historyRun(db, `history_${slot}`, {
        mode: "official", status: accepted || slot === 2 ? "succeeded" : "cancelled",
        attemptNumber: slot,
        refundedAt: !accepted && slot === 2 ? NOW : null,
      });
      await db.insert(officialAttempts).values({
        id: `history_claim_${slot}`, ...ACCOUNTING_SCOPE, runId: `history_${slot}`,
        attemptNumber: slot, consumed: true, claimedAt: NOW,
      });
    }
    const historicalClaims = await db.select().from(officialAttempts);
    const promoted = await promotePracticeRun(env(binding, "modal", { async send() {} }), actor, PRACTICE_RUN_ID);
    const [run] = await db.select().from(runs).where(eq(runs.id, promoted.runId));
    assert.equal(run.attemptNumber, 2);
    assert.equal((await readRunAccounting(db, ACCOUNTING_SCOPE)).officialUsed, 1);
    assert.deepEqual(await db.select().from(officialAttempts), historicalClaims, "admission leaves historical data untouched");
  });
}
