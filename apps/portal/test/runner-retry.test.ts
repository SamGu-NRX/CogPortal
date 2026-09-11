import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { buildRunJob, enqueueRun, prepareRetryJob } from "../worker/execution/runner.ts";
import { runs, teams, cohorts, benchmarks, type RunRow, type TeamRow, type BenchmarkRow } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { PreparedEnvironmentV1Schema, type RunJobV1 } from "@cogworks/contracts/protocol";
import { ApiHttpError } from "../worker/http/errors.ts";

const digest = "b".repeat(64);
const team: TeamRow = {
  id: "team_retry", cohortId: "cohort_retry", name: "Retry team", description: null,
  repoOwner: "course", repoName: "team", repoFullName: "course/team", repoId: 42,
  repoUrl: "https://github.com/course/team", defaultBranch: "main",
  templateSourceRepoId: null, discordChannelId: null, provenance: "live",
};
const benchmark: BenchmarkRow = {
  id: "vision-recognition", version: 1, contractVersion: "cogworks.submissions.v1",
  pluginVersion: "1", datasetVersion: "official-v1", scorerVersion: "1", runtimeVersion: "python-3.11",
  entryPointName: "submission", title: "Vision", module: "vision", summary: "Retry test",
  active: true, primaryMetricKey: "accuracy", sandboxContract: 1,
};
function environment(overrides: Partial<Env> = {}): Env {
  // Retry preparation needs no database; enqueue tests supply the SQLite binding.
  let db: Env["DB"] | undefined;
  return {
    get DB() { assert.ok(db, "Unexpected database access before binding setup"); return db; },
    set DB(value: Env["DB"]) { db = value; },
    get ASSETS(): Env["ASSETS"] { throw new Error("Unexpected asset access in runner test"); },
    get RUN_SURFACES(): Env["RUN_SURFACES"] { throw new Error("Unexpected run-surface access in runner test"); },
    ENVIRONMENT: "development", DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "modal", PUBLIC_ORIGIN: "https://portal.example",
    MODAL_RUNNER_URL: "https://runner.example", RUNNER_SIGNING_SECRET: "test-secret",
    RUNNER_IMAGE_DIGEST: "im-original", RUNNER_SIGNING_KEY_ID: "original-key",
    ...overrides,
  };
}
function original(mode: "practice" | "official" = "practice", withWeights = false) {
  const env = environment();
  const run: RunRow = {
    id: "run_original", teamId: team.id, benchmarkId: benchmark.id, benchmarkVersion: 1,
    contractVersion: benchmark.contractVersion, mode, status: "failed", branch: "main",
    sha: "a".repeat(40), repositoryId: team.repoId, provider: "modal", protocolVersion: "1",
    datasetVersion: mode === "practice" ? "practice-v1" : benchmark.datasetVersion,
    scorerVersion: benchmark.scorerVersion, runtimeVersion: benchmark.runtimeVersion,
    preparedArtifactId: mode === "official" ? "im-prepared" : null,
    preparedEnvironmentJson: null,
    createdAt: 1, finishedAt: null, lastEventSequence: -1, dispatchAttempts: 0,
    parentRunId: null, retryOfRunId: null, dispatchJobJson: null, attemptNumber: null,
    failureCategory: null, failurePhase: null, failureDetail: null, failureConsumedAttempt: false,
    refundedAt: null, log: null, diagnosticsJson: null, wiringJson: null, refusalJson: null,
    sweepJson: null, weightsSuppliedJson: "[]", environmentDigest: null, surfaceId: null,
  };
  if (mode === "official") {
    const evidence = PreparedEnvironmentV1Schema.parse(JSON.parse(readFileSync(
      new URL("../../../protocols/v1/fixtures/prepared-environment.valid.json", import.meta.url), "utf8",
    )));
    run.preparedEnvironmentJson = JSON.stringify({ ...evidence,
      artifactId: run.preparedArtifactId, benchmarkId: run.benchmarkId,
      source: { repositoryId: run.repositoryId, fullName: team.repoFullName, sha: run.sha },
    });
  }
  const job = buildRunJob(env, run, team, benchmark,
    withWeights ? [{ path: "model.pkl", size: 3, sha256: digest }] : []);
  run.dispatchJobJson = JSON.stringify(job);
  return { env, run, job };
}
function conflict(error: unknown) {
  assert.ok(error instanceof ApiHttpError);
  assert.equal(error.status, 409);
  return true;
}
function object(size = 3, sha256: string | null = digest) {
  let checksum: ArrayBuffer | undefined;
  if (sha256 !== null) {
    const bytes = sha256.match(/../g);
    assert.ok(bytes, "Weight checksum must contain hexadecimal bytes");
    checksum = Uint8Array.from(bytes.map((byte) => parseInt(byte, 16))).buffer;
  }
  return { size, checksums: { sha256: checksum } };
}

function weightBucket(head: (key: string) => Promise<ReturnType<typeof object> | null>): NonNullable<Env["ARTIFACTS"]> {
  // SAFETY: the runner only calls R2.head and reads size/checksums.sha256.
  // Object bodies, HTTP metadata, and other bucket operations are not exercised.
  return { head } as NonNullable<Env["ARTIFACTS"]>;
}

function runQueue(send: (job: RunJobV1) => Promise<void>): NonNullable<Env["RUN_QUEUE"]> {
  // SAFETY: enqueueRun only awaits send and ignores its provider metadata.
  // The callback receives the validated job; metrics/sendBatch are not called.
  return { send } as unknown as NonNullable<Env["RUN_QUEUE"]>;
}

test("retry preserves recorded inputs, ignores late artifacts, and refreshes only transport and IDs", async () => {
  for (const mode of ["practice", "official"] as const) {
    const { run, job } = original(mode);
    run.preparedArtifactId = "im-late-completion";
    const env = environment({
      PUBLIC_ORIGIN: "https://new-portal.example", RUNNER_SIGNING_KEY_ID: "new-key",
    });
    const retry = await prepareRetryJob(env, run, team, benchmark, "run_retry");
    assert.equal(retry.runId, "run_retry");
    assert.notEqual(retry.jobId, job.jobId);
    assert.deepEqual(retry.callback, {
      url: "https://new-portal.example/api/internal/v1/runner/events", keyId: "new-key",
    });
    assert.deepEqual({ ...retry, jobId: job.jobId, runId: job.runId, callback: job.callback }, job);
  }
});

test("saved-job Retry preserves provisioning evidence and refuses legacy or mismatched proof", async () => {
  const { env, run, job } = original("official");
  assert.ok(job.preparedEnvironment);
  run.preparedEnvironmentJson = JSON.stringify({ ...job.preparedEnvironment, artifactId: "im-late-other" });
  const retry = await prepareRetryJob(env, run, team, benchmark, "run_retry");
  assert.deepEqual(retry.preparedEnvironment, job.preparedEnvironment);
  assert.equal(retry.benchmark.sandboxContract, 1);
  for (const mutate of [
    (candidate: RunJobV1) => { delete candidate.preparedEnvironment; },
    (candidate: RunJobV1) => { candidate.preparedEnvironment = null; },
    (candidate: RunJobV1) => { candidate.preparedEnvironment!.artifactId = "im-other"; },
    (candidate: RunJobV1) => { candidate.preparedEnvironment!.source.sha = "f".repeat(40); },
    (candidate: RunJobV1) => { delete candidate.benchmark.sandboxContract; },
    (candidate: RunJobV1) => { candidate.benchmark.sandboxContract = 2; },
  ]) {
    const candidate = structuredClone(job);
    mutate(candidate);
    await assert.rejects(prepareRetryJob(env, { ...run, dispatchJobJson: JSON.stringify(candidate) }, team, benchmark, "run_retry"), conflict);
  }
});

test("a late practice observation does not become Retry's preparation input", async () => {
  const { env, run, job } = original("practice");
  const official = original("official");
  run.preparedArtifactId = official.run.preparedArtifactId;
  run.preparedEnvironmentJson = official.run.preparedEnvironmentJson;
  const retry = await prepareRetryJob(env, run, team, benchmark, "run_retry");
  assert.equal(retry.preparedArtifactId, null);
  assert.equal(retry.preparedEnvironment, null);
  assert.deepEqual(retry.weights, job.weights);
});

test("retry rejects absent, malformed, or mismatched recorded inputs", async () => {
  const mutations: Array<(run: RunRow, job: RunJobV1) => void> = [
    (run) => { run.dispatchJobJson = null; },
    (run) => { run.dispatchJobJson = "{"; },
    (run) => { run.dispatchJobJson = "{}"; },
    (_, job) => { job.runId = "run_other"; },
    (_, job) => { job.mode = "official"; },
    (_, job) => { job.source.sha = "c".repeat(40); },
    (_, job) => { job.source.repositoryId = 43; },
    (_, job) => { job.benchmark.version = 2; },
    (_, job) => { job.benchmark.contractVersion = "changed"; },
    (_, job) => { job.benchmark.datasetVersion = "changed"; },
    (_, job) => { job.benchmark.scorerVersion = "changed"; },
    (_, job) => { delete job.weights; },
    (_, job) => { job.runtime.timeoutSeconds = 800; },
    (_, job) => { job.preparedArtifactId = "im-unexpected"; },
    (run) => { run.provider = "fixture"; },
    (run) => { run.status = "succeeded"; },
    (run) => { run.teamId = "other_team"; },
  ];
  for (const mutate of mutations) {
    const { env, run, job } = original();
    const before = run.dispatchJobJson;
    mutate(run, job);
    if (run.dispatchJobJson === before) run.dispatchJobJson = JSON.stringify(job);
    await assert.rejects(prepareRetryJob(env, run, team, benchmark, "run_retry"), conflict);
  }
  const { env, run } = original();
  await assert.rejects(prepareRetryJob(env, run, team, benchmark, run.id), conflict);
});

test("retry refuses current source, benchmark, runtime, and provider drift", async () => {
  const { env, run } = original();
  for (const changed of [
    { ...team, repoId: 43 }, { ...team, repoName: "replacement" },
    { ...team, repoFullName: "course/replacement" },
  ]) await assert.rejects(prepareRetryJob(env, run, changed, benchmark, "run_retry"), conflict);
  for (const changed of [
    { ...benchmark, id: "language-search" }, { ...benchmark, version: 2 },
    { ...benchmark, contractVersion: "changed" }, { ...benchmark, pluginVersion: "changed" },
    { ...benchmark, pluginVersion: "" },
    { ...benchmark, scorerVersion: "changed" }, { ...benchmark, runtimeVersion: "changed" },
  ]) await assert.rejects(prepareRetryJob(env, run, team, changed, "run_retry"), conflict);
  for (const changed of [
    { EXECUTION_PROVIDER: "fixture" as const },
    { RUNNER_IMAGE_DIGEST: "im-changed" }, { RUNNER_PYTHON_VERSION: "3.12" },
  ]) await assert.rejects(prepareRetryJob(environment(changed), run, team, benchmark, "run_retry"), conflict);
  const official = original("official");
  await assert.rejects(prepareRetryJob(official.env, official.run, team,
    { ...benchmark, datasetVersion: "changed" }, "run_retry"), conflict);
});

test("retry rechecks saved weight size and digest at the original object key", async () => {
  const { env, run, job } = original("practice", true);
  const keys: string[] = [];
  env.ARTIFACTS = weightBucket(async (key) => { keys.push(key); return object(); });
  const retry = await prepareRetryJob(env, run, team, benchmark, "run_retry");
  assert.deepEqual(retry.weights, job.weights);
  assert.deepEqual(keys, [`weights/course/team/${run.sha}/model.pkl`]);
  for (const stored of [null, object(4), object(3, null), object(3, "c".repeat(64))]) {
    env.ARTIFACTS = weightBucket(async () => stored);
    await assert.rejects(prepareRetryJob(env, run, team, benchmark, "run_retry"), conflict);
  }
  delete env.ARTIFACTS;
  await assert.rejects(prepareRetryJob(env, run, team, benchmark, "run_retry"), conflict);
});

test("retry rejects duplicate and unsafe saved weight paths", async () => {
  for (const path of ["../model.pkl", "/model.pkl", "model.pkl"]) {
    const { env, run, job } = original("practice", true);
    assert.ok(job.weights);
    assert.ok(job.weights[0]);
    job.weights[0].path = path;
    if (path === "model.pkl") job.weights.push({ ...job.weights[0] });
    run.dispatchJobJson = JSON.stringify(job);
    env.ARTIFACTS = weightBucket(async () => object());
    await assert.rejects(prepareRetryJob(env, run, team, benchmark, "run_retry"), conflict);
  }
});

async function database(failPersistence = false) {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql"))
    .sort().filter((file) => !/^(0002_seed|0016_backfill)/.test(file))) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const queries: string[] = [];
  const adapter = {
    prepare(query: string) {
      queries.push(query);
      if (failPersistence && query.startsWith('update "runs"')) {
        throw new Error("recording unavailable");
      }
      const statement = sqlite.prepare(query);
      let values: SQLInputValue[] = [];
      const prepared = {
        bind(...params: SQLInputValue[]) { values = params; return prepared; },
        async run() { return { success: true, meta: statement.run(...values) }; },
        async all() { return { success: true, results: statement.all(...values) }; },
        async raw() {
          statement.setReturnArrays(true);
          const rows = statement.all(...values);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
  };
  // SAFETY: these Drizzle queries use only prepare/bind/run/all/raw. SQLite
  // supplies real migrated rows and changes counts; D1 batch/session APIs and
  // platform timing metadata are not exercised by this dispatch test suite.
  const binding = adapter as unknown as Env["DB"];
  const db = drizzle(binding);
  await db.insert(cohorts).values({ id: "cohort_retry", slug: "retry", name: "Retry", joinCode: "RETRY", active: true });
  await db.insert(teams).values(team);
  await db.insert(benchmarks).values(benchmark);
  return { db, binding, queries, sqlite };
}

test("enqueue records inputs before sending and reuses the first saved job", async () => {
  const { db, binding, queries, sqlite } = await database();
  try {
    const { env, run } = original();
    run.dispatchJobJson = null;
    await db.insert(runs).values(run);
    env.DB = binding;
    const sent: RunJobV1[] = [];
    env.RUN_QUEUE = runQueue(async (job) => {
      const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
      assert.ok(stored?.dispatchJobJson);
      assert.deepEqual(JSON.parse(stored.dispatchJobJson), job);
      sent.push(job);
    });
    await Promise.all([enqueueRun(env, run, team, benchmark), enqueueRun(env, run, team, benchmark)]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    queries.length = 0;
    run.preparedArtifactId = "im-late";
    await db.update(runs).set({ preparedArtifactId: "im-late" }).where(eq(runs.id, run.id));
    await enqueueRun(env, run, { ...team, repoName: "ignored" }, benchmark);
    assert.deepEqual(sent[2], sent[0]);
    assert.ok(!queries.some((query) => /local_reports|team_members/.test(query)));
  } finally { sqlite.close(); }
});

test("enqueue rejects a saved job for another run without sending or rebuilding", async () => {
  const { db, binding, queries, sqlite } = await database();
  try {
    const { env, run, job } = original();
    job.runId = "run_other";
    run.dispatchJobJson = JSON.stringify(job);
    await db.insert(runs).values(run);
    env.DB = binding;
    let sent = false;
    env.RUN_QUEUE = runQueue(async () => { sent = true; });
    await assert.rejects(enqueueRun(env, run, team, benchmark), conflict);
    assert.equal(sent, false);
    assert.ok(!queries.some((query) => /local_reports|team_members/.test(query)));
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    assert.equal(stored.dispatchJobJson, run.dispatchJobJson);
  } finally { sqlite.close(); }
});

test("invalid new jobs and persistence failure cannot send an unrecorded execution", async () => {
  for (const failPersistence of [false, true]) {
    const { db, binding, sqlite } = await database(failPersistence);
    try {
      const { env, run } = original();
      run.dispatchJobJson = null;
      await db.insert(runs).values(run);
      env.DB = binding;
      let sent = false;
      env.RUN_QUEUE = runQueue(async () => { sent = true; });
      await assert.rejects(enqueueRun(env, run, team,
        failPersistence ? benchmark : { ...benchmark, pluginVersion: "" }));
      assert.equal(sent, false);
      const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
      assert.equal(stored.dispatchJobJson, null);
    } finally { sqlite.close(); }
  }
});

test("enqueue retains a recorded job through queue failure and rejects changed saved weight bytes", async () => {
  const { db, binding, queries, sqlite } = await database();
  try {
    const { env, run } = original("practice", true);
    await db.insert(runs).values(run);
    env.DB = binding;
    env.ARTIFACTS = weightBucket(async () => object());
    env.RUN_QUEUE = runQueue(async () => { throw new Error("queue unavailable"); });
    await assert.rejects(enqueueRun(env, run, team, benchmark), /queue unavailable/);
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    assert.equal(stored.dispatchJobJson, run.dispatchJobJson);
    let sent = false;
    env.RUN_QUEUE = runQueue(async () => { sent = true; });
    env.ARTIFACTS = weightBucket(async () => object(4));
    await assert.rejects(enqueueRun(env, run, team, benchmark), conflict);
    assert.equal(sent, false);
    assert.ok(!queries.some((query) => /local_reports|team_members/.test(query)));
  } finally { sqlite.close(); }
});
