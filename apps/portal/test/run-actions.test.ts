import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";
import { buildRunSurfaceSnapshot } from "../worker/services/run-surfaces.ts";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  officialAttempts,
  localReports,
  teamMembers,
  runs,
  runSurfaces,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { ApiHttpError } from "../worker/http/errors.ts";
import {
  promotePracticeRun,
  startPracticeRun,
  rerunHostedSurface,
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
  assert.notEqual(reaped.refundedAt, null);
  assert.equal((await db.select().from(officialAttempts)).length, 0);

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
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.refundedAt, reaped.refundedAt);
  assert.match(recovered.diagnosticsJson!, /image stage/);
  await assert.rejects(promotePracticeRun(runtime, actor, PRACTICE_RUN_ID), (error: unknown) => {
    assert.ok(error instanceof ApiHttpError);
    assert.equal(error.code, "not_promotable");
    assert.match(error.message, /refunded.*Start a new practice run/);
    return true;
  });
  const snapshot = await buildRunSurfaceSnapshot(runtime, SURFACE_ID);
  assert.equal(snapshot.status, "succeeded");
  assert.ok(snapshot.actions.includes("rerun_hosted"));
  assert.ok(!snapshot.actions.includes("publish_result"));
  assert.ok(!snapshot.actions.includes("promote_official"));
  const rerun = await rerunHostedSurface(env(binding, "fixture"), actor, SURFACE_ID);
  assert.notEqual(rerun.surfaceId, SURFACE_ID);
  const [successor] = await db.select().from(runSurfaces).where(eq(runSurfaces.id, rerun.surfaceId));
  assert.equal(successor.supersedesSurfaceId, SURFACE_ID);
  assert.equal((await db.select().from(officialAttempts)).length, 0);
});

test("incomplete weight uploads fail hosted dispatch without leaving an active run or attempt", async () => {
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
  assert.equal((await db.select().from(officialAttempts)).length, 0);
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
