import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";
import { appendRunStreamEvent, buildRunSurfaceSnapshot, publishRunSurface } from "../worker/services/run-surfaces.ts";
import { runSurfaceHubs } from "./fixtures/run-surface-hub.ts";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { DashboardSchema, RUN_PHASES, type Dashboard } from "@cogworks/contracts/schema";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardPage } from "../src/routes/DashboardPage.tsx";
import { createAuth } from "../worker/auth/better-auth.ts";
import { registerDashboardRoutes } from "../worker/routes/dashboard.ts";
import { serializeRunDetail } from "../worker/http/serializers.ts";
import { insertRunWithCapacity, readRunAccounting } from "../worker/services/run-accounting.ts";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cliDevices,
  cohorts,
  leaderboardSelections,
  localRunSessions,
  officialAttempts,
  localReports,
  runs,
  runPhases,
  runSurfaces,
  runMetrics,
  teamMembers,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { ApiHttpError, handleError } from "../worker/http/errors.ts";
import { registerRunRoutes } from "../worker/routes/runs.ts";
import { weightObjectKey } from "../worker/services/weights.ts";
import { runSourceRefusal } from "../worker/services/run-source.ts";
import {
  performRunSurfaceMutation,
  promotePracticeRun,
  publishOfficialRun,
  rerunHostedSurface,
  startPracticeRun,
  retryRun,
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

/** Counts snapshot publications, so a refusal can be shown to have had no
 *  observable effect rather than only to have thrown. */
let hubPublications = 0;

function env(binding: unknown, provider: "fixture" | "modal", queue?: { send(): Promise<void> }): Env {
  const runtime = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: provider,
    PUBLIC_ORIGIN: "https://portal.example",
    MODAL_RUNNER_URL: "https://runner.example",
    RUNNER_SIGNING_SECRET: "test-signing-secret-that-is-long-enough",
    RUN_QUEUE: queue,
  } as unknown as Env;
  const namespace = runSurfaceHubs(runtime).namespace;
  // Keep the refusal tests' publication counter while exercising the real hub's
  // revision stamping; an empty response no longer satisfies the snapshot API.
  // SAFETY: snapshot callers use only idFromName and fetch(url, init).
  runtime.RUN_SURFACES = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: (url: string, init: RequestInit) => {
        if (new URL(url).pathname === "/publish") hubPublications += 1;
        return namespace.get(id).fetch(url, init);
      },
    }),
  } as unknown as Env["RUN_SURFACES"];
  return runtime;
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
      assert.deepEqual(snapshot.source, before.source);
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
    assert.equal(next.repositoryFullName, original?.repositoryFullName);
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

test("Retry revalidates the connected team and refuses unknown repository identity", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.update(runs).set({ status: "failed", provider: "fixture" }).where(eq(runs.id, PRACTICE_RUN_ID));
  // The request's actor still names the old repository after the stored team changes.
  await db.update(teams).set({ repoId: FIXTURE_REPO.repositoryId + 1 }).where(eq(teams.id, actor.team.id));
  await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, PRACTICE_RUN_ID), /source is no longer/);
  await db.update(teams).set({ repoId: null }).where(eq(teams.id, actor.team.id));
  await db.update(runs).set({ repositoryId: null }).where(eq(runs.id, PRACTICE_RUN_ID));
  await assert.rejects(retryRun(env(binding, "fixture"), actor, SURFACE_ID, PRACTICE_RUN_ID), /source is no longer/);
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
      assert.equal(
        official.repositoryFullName,
        "some-org/the-repository-it-ran-from",
        "the official attempt lost the repository its practice run used",
      );
      assert.equal((await readRunAccounting(db, ACCOUNTING_SCOPE)).officialReserved, 1);
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
    // Each panel's own call to action, stated independently: the dashboard
    // only offers promotion, and the run detail shares one sentence with
    // PUBLISH. Compared in full so a changed clause cannot pass unnoticed.
    assert.equal(dashboard.latestCandidate?.sourceRefusal, runSourceRefusal(actor.team, row, "promote it"));
    assert.equal(detail.sourceRefusal, runSourceRefusal(actor.team, row, "act on it"));
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
      // The panel renders its own sentence, which ends in "promote it".
      assert.ok(dashboard.latestCandidate?.sourceRefusal);
      assert.ok(html.includes(dashboard.latestCandidate.sourceRefusal));
      assert.match(dashboard.latestCandidate.sourceRefusal, /to promote it\.$/);
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

for (const [recorded, current] of [[null, null], [null, FIXTURE_REPO.repositoryId], [123, FIXTURE_REPO.repositoryId], [FIXTURE_REPO.repositoryId, null], [FIXTURE_REPO.repositoryId, FIXTURE_REPO.repositoryId]] as const) {
  test(`Retry advertisement and admission require known matching repository IDs: ${recorded}/${current}`, async () => {
    const { db, binding } = freshDb();
    const actor = await seedPromotion(db);
    await db.update(runs).set({ status: "failed", provider: "fixture", repositoryId: recorded }).where(eq(runs.id, PRACTICE_RUN_ID));
    await db.update(teams).set({ repoId: current }).where(eq(teams.id, actor.team.id));
    actor.team.repoId = current;
    const runtime = env(binding, "fixture");
    const snapshot = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
    const eligible = recorded !== null && recorded === current;
    assert.equal(snapshot.actions.includes("retry"), eligible);
    if (!eligible) await assert.rejects(retryRun(runtime, actor, SURFACE_ID, PRACTICE_RUN_ID), { code: "invalid_request" });
    else await retryRun(runtime, actor, SURFACE_ID, PRACTICE_RUN_ID);
  });
}

test("DO revisions survive recreation and upgrade legacy latest payloads", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  const runtime = env(binding, "modal");
  const hubs = runSurfaceHubs(runtime);
  runtime.RUN_SURFACES = hubs.namespace;
  const first = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  assert.equal(first.snapshotRevision, 1);
  hubs.get(SURFACE_ID).restart();
  const second = await publishRunSurface(runtime, SURFACE_ID);
  assert.equal(second.snapshotRevision, 2);
  assert.equal(second.updatedAt, first.updatedAt);
  const { snapshotRevision: _, ...legacy } = second;
  hubs.get(SURFACE_ID).values.set("latest", JSON.stringify(legacy));
  hubs.get(SURFACE_ID).values.delete("snapshotRevision");
  hubs.get(SURFACE_ID).restart();
  assert.equal((await buildRunSurfaceSnapshot(runtime, SURFACE_ID)).snapshotRevision, 1);
  assert.deepEqual(hubs.requests.map((request) => request.operation), ["/snapshot", "/publish", "/snapshot"]);
});

test("socket connection builds a numbered snapshot before any publication and shares the read sequence", async (t) => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  const runtime = env(binding, "modal");
  const hubs = runSurfaceHubs(runtime);
  runtime.RUN_SURFACES = hubs.namespace;
  const sent: string[] = [];
  const previousPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  Object.assign(globalThis, {
    WebSocketPair: class {
      0 = {};
      1 = { send(payload: string) { sent.push(payload); }, close() {} };
    },
  });
  t.after(() => {
    if (previousPair) Object.defineProperty(globalThis, "WebSocketPair", previousPair);
    else Reflect.deleteProperty(globalThis, "WebSocketPair");
  });
  // Node's Response rejects 101; only the host upgrade response is substituted.
  const NativeResponse = Response;
  t.mock.method(globalThis, "Response", class extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
    }
  });
  const response = await hubs.get(SURFACE_ID).fetch(new Request(`https://run-surface.internal/connect?surfaceId=${SURFACE_ID}`, {
    headers: { Upgrade: "websocket" },
  }));
  assert.equal(response.status, 101);
  assert.equal(JSON.parse(sent[0]).snapshotRevision, 1);
  const read = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  assert.equal(read.snapshotRevision, 2);
  assert.deepEqual(JSON.parse(sent[1]), read);
  const published = await publishRunSurface(runtime, SURFACE_ID);
  assert.equal(published.snapshotRevision, 3);
  assert.deepEqual(JSON.parse(sent[2]), published);
  await hubs.get(SURFACE_ID).alarm();
  assert.equal(JSON.parse(sent[3]).snapshotRevision, 4);
});

test("snapshot wrappers reject unstamped or wrong-console payloads and await publication failure", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  const runtime = env(binding, "modal");
  const snapshot = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  for (const payload of [{ ...snapshot, snapshotRevision: 0 }, { ...snapshot, id: "surface_aaaaaaaaaaaaaaaaaaaa" }]) {
    // SAFETY: these wrappers use only namespace lookup and the stub's fetch.
    runtime.RUN_SURFACES = {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => Response.json(payload) }),
    } as unknown as Env["RUN_SURFACES"];
    await assert.rejects(buildRunSurfaceSnapshot(runtime, SURFACE_ID), /unstamped or mismatched/);
    await assert.rejects(publishRunSurface(runtime, SURFACE_ID), /unstamped or mismatched/);
  }
  // SAFETY: publication reaches only namespace lookup and the stub's fetch.
  runtime.RUN_SURFACES = {
    idFromName: (id: string) => id,
    get: () => ({ fetch: async () => new Response("Unavailable", { status: 503 }) }),
  } as unknown as Env["RUN_SURFACES"];
  await assert.rejects(publishRunSurface(runtime, SURFACE_ID), /could not be updated/);
});

test("overlapping read and publish signals serialize the complete database build", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  await db.update(runs).set({ status: "queued", finishedAt: null }).where(eq(runs.id, PRACTICE_RUN_ID));
  // SAFETY: freshDb supplies this D1-shaped adapter; the hook only wraps raw.
  const d1 = binding as { prepare(query: string): { raw(): Promise<unknown> } };
  const prepare = d1.prepare.bind(d1);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let builds = 0;
  d1.prepare = (query) => {
    const statement = prepare(query);
    if (query.includes('from "runs"') && query.includes('"runs"."surface_id" = ?') && query.includes("order by")) {
      const raw = statement.raw.bind(statement);
      statement.raw = async () => {
        builds += 1;
        const rows = await raw();
        if (builds === 1) { entered(); await gate; }
        return rows;
      };
    }
    return statement;
  };
  const runtime = env(binding, "modal");
  const hubs = runSurfaceHubs(runtime);
  runtime.RUN_SURFACES = hubs.namespace;
  const firstResponse = buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  await blocked;
  await db.update(runs).set({ status: "evaluating" }).where(eq(runs.id, PRACTICE_RUN_ID));
  const secondResponse = publishRunSurface(runtime, SURFACE_ID);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 1, "the second signal must not start its database build while the first is paused");
  release();
  const [queued, evaluating] = await Promise.all([firstResponse, secondResponse]);
  assert.equal(queued.phase, "queued");
  assert.equal(evaluating.phase, "evaluating");
  assert.equal(queued.updatedAt, evaluating.updatedAt);
  assert.equal(queued.snapshotRevision, 1);
  assert.equal(evaluating.snapshotRevision, 2);
  assert.deepEqual(hubs.get(SURFACE_ID).messages, [queued, evaluating]);
});

test("publishing notifies every official console in scope, including the previously selected result", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  const firstId = await seedOfficial(db, "succeeded");
  const [first] = await db.select().from(runs).where(eq(runs.id, firstId));
  const [surface] = await db.select().from(runSurfaces).where(eq(runSurfaces.id, SURFACE_ID));
  const otherSurface = "surface_aaaaaaaaaaaaaaaaaaaa";
  const thirdSurface = "surface_bbbbbbbbbbbbbbbbbbbb";
  const excludedSurface = "surface_cccccccccccccccccccc";
  for (const [id, version] of [[otherSurface, 1], [thirdSurface, 1], [excludedSurface, 2]] as const) {
    await db.insert(runSurfaces).values({ ...surface, id, benchmarkVersion: version });
    await db.insert(runs).values({ ...first, id: `run_${id}`, surfaceId: id, benchmarkVersion: version, attemptNumber: null });
  }
  const runtime = env(binding, "modal");
  const hubs = runSurfaceHubs(runtime);
  runtime.RUN_SURFACES = hubs.namespace;
  const before = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  await publishOfficialRun(runtime, actor, firstId);
  const selected = hubs.get(SURFACE_ID).messages.at(-1)!;
  await publishOfficialRun(runtime, actor, `run_${otherSurface}`);
  const deselected = hubs.get(SURFACE_ID).messages.at(-1)!;
  assert.deepEqual([before.published, selected.published, deselected.published], [false, true, false]);
  assert.deepEqual([before.snapshotRevision, selected.snapshotRevision, deselected.snapshotRevision], [1, 2, 3]);
  assert.equal(before.updatedAt, deselected.updatedAt);
  assert.equal(hubs.get(otherSurface).messages.at(-1)?.published, true);
  assert.deepEqual(new Set(hubs.requests.filter((r) => r.operation === "/publish").map((r) => r.surfaceId)), new Set([SURFACE_ID, otherSurface, thirdSurface]));
  assert.equal(hubs.requests.some((r) => r.surfaceId === excludedSurface), false);
});

test("late old-generation evidence updates history without replacing the current execution", async () => {
  const { db, binding } = freshDb();
  const actor = await seedPromotion(db);
  await db.update(runs).set({ status: "failed", provider: "fixture" }).where(eq(runs.id, PRACTICE_RUN_ID));
  const runtime = env(binding, "fixture");
  const before = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  const retry = await performRunSurfaceMutation(runtime, actor, SURFACE_ID, "retry", { runId: PRACTICE_RUN_ID });
  await appendRunStreamEvent(runtime, SURFACE_ID, {
    eventId: "late_old_execution", source: "practice", sourceRunId: PRACTICE_RUN_ID,
    sourceSequence: 99, phase: "evaluating", code: "run.failed.runtime", occurredAt: Date.now() + 10_000,
    elapsedMs: 2_000, progress: null,
  });
  const latest = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  assert.equal(latest.executionGeneration, before.executionGeneration + 1);
  assert.equal(latest.practiceRunId, retry.practiceRunId);
  assert.equal(latest.phase, retry.phase);
  assert.ok(latest.snapshotRevision > retry.snapshotRevision);
  assert.ok(latest.events.some((event) => event.eventId === "late_old_execution"));
});

test("alarm missing-context cleanup preserves the revision through restoration and recreation", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  const runtime = env(binding, "modal");
  const hubs = runSurfaceHubs(runtime);
  runtime.RUN_SURFACES = hubs.namespace;
  const first = await publishRunSurface(runtime, SURFACE_ID);
  const [benchmark] = await db.select().from(benchmarks).where(and(eq(benchmarks.id, BENCHMARK_ID), eq(benchmarks.version, 1)));
  await db.delete(benchmarks);
  await hubs.get(SURFACE_ID).alarm();
  assert.equal(hubs.get(SURFACE_ID).values.has("latest"), false);
  assert.equal(hubs.get(SURFACE_ID).values.has("surfaceId"), false);
  assert.equal(hubs.get(SURFACE_ID).values.get("snapshotRevision"), first.snapshotRevision);
  await db.insert(benchmarks).values(benchmark);
  hubs.get(SURFACE_ID).restart();
  assert.equal((await buildRunSurfaceSnapshot(runtime, SURFACE_ID)).snapshotRevision, first.snapshotRevision + 1);
});

for (const operation of ["snapshot", "publish", "connect", "alarm"] as const) {
  for (const failure of ["missing_context", "database"] as const) {
    test(`${operation} handles ${failure} outside the gate without resetting the hub`, async (t) => {
      const { db, binding } = freshDb();
      await seedPromotion(db);
      const runtime = env(binding, "modal");
      const hubs = runSurfaceHubs(runtime);
      runtime.RUN_SURFACES = hubs.namespace;
      const first = await publishRunSurface(runtime, SURFACE_ID);
      const hub = hubs.get(SURFACE_ID);
      const [benchmark] = await db.select().from(benchmarks).where(and(eq(benchmarks.id, BENCHMARK_ID), eq(benchmarks.version, 1)));
      const logs: string[] = [];
      t.mock.method(console, "error", (message: string) => { logs.push(message); });
      if (failure === "missing_context") {
        await db.delete(benchmarks).where(and(eq(benchmarks.id, BENCHMARK_ID), eq(benchmarks.version, 1)));
      } else {
        // SAFETY: prepare throws before the builder can use any other D1 method.
        runtime.DB = { prepare() { throw new Error("Transient database failure"); } } as unknown as Env["DB"];
      }
      const started = Date.now();
      if (operation === "alarm") {
        await hub.alarm();
        if (failure === "database") {
          assert.ok(hub.scheduledAlarm !== null && hub.scheduledAlarm >= started + 2_000);
          assert.match(logs[0] ?? "", /run_surface_tick_failed/);
          assert.match(logs[0] ?? "", /Transient database failure/);
          assert.equal(hub.values.has("latest"), true);
        } else {
          assert.equal(hub.scheduledAlarm, null);
          assert.equal(hub.values.has("latest"), false);
        }
      } else if (operation === "connect") {
        const request = new Request(`https://run-surface.internal/connect?surfaceId=${SURFACE_ID}`, {
          headers: { Upgrade: "websocket" },
        });
        if (failure === "database") await assert.rejects(hub.fetch(request), /Transient database failure/);
        else {
          const response = await hub.fetch(request);
          assert.equal(response.status, 404);
          assert.equal(await response.text(), "Run surface context no longer exists.");
        }
      } else {
        const request = operation === "snapshot" ? buildRunSurfaceSnapshot : publishRunSurface;
        if (failure === "database") await assert.rejects(request(runtime, SURFACE_ID), /Transient database failure/);
        else await assert.rejects(request(runtime, SURFACE_ID), {
          status: 404, code: "not_found", message: "Run surface context no longer exists.",
        });
      }
      assert.deepEqual(hub.gateRejections, []);
      assert.equal(hub.messages.length, 1, "a failed build must not broadcast a fallback snapshot");
      assert.equal(hub.values.get("snapshotRevision"), first.snapshotRevision);
      if (failure === "missing_context") await db.insert(benchmarks).values(benchmark);
      else runtime.DB = binding as Env["DB"];
      const recovered = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
      assert.equal(recovered.snapshotRevision, first.snapshotRevision + 1);
      assert.deepEqual(hub.gateRejections, []);
    });
  }
}

test("missing snapshot context retains its 404 across the DO request boundary", async () => {
  const { db, binding } = freshDb();
  await seedPromotion(db);
  await db.delete(benchmarks);
  await assert.rejects(buildRunSurfaceSnapshot(env(binding, "modal"), SURFACE_ID), {
    status: 404, code: "not_found", message: "Run surface context no longer exists.",
  });
});

test("a weight download reads the repository the run recorded, not the team's current name", async () => {
  // enqueueRun builds the manifest under the run's recorded repository, so the
  // download route has to resolve the same key or a rename between queue and
  // fetch turns every uploaded weight into a 404 during preparation.
  const { db, binding } = freshDb();
  await seedPromotion(db);
  const keys: string[] = [];
  const runtime = {
    ...env(binding, "modal"),
    ARTIFACTS: { get: async (key: string) => { keys.push(key); return null; } },
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  registerRunRoutes(app);
  app.onError(handleError);
  const path = `/v1/runs/${PRACTICE_RUN_ID}/weights/models/search.pkl`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const response = await app.fetch(new Request(`http://localhost${path}`, { headers: {
    "X-Cogworks-Key-Id": "runner-v1",
    "X-Cogworks-Timestamp": timestamp,
    "X-Cogworks-Signature": `v1=${await hmacSignature("test-signing-secret-that-is-long-enough", timestamp, path)}`,
  } }), runtime);
  assert.equal(response.status, 404, `the stub holds no object, so the route reports none: ${await response.text()}`);
  assert.deepEqual(keys, [weightObjectKey("some-org/the-repository-it-ran-from", "a".repeat(40), "models/search.pkl")]);
});
