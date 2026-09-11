import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Database } from "../worker/db/client.ts";
import { cohorts, runMetrics, runs, teams } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { handleError } from "../worker/http/errors.ts";
import { serializeMetric } from "../worker/http/serializers.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";

/**
 * Whether the metadata a scorer sends about a metric survives being stored.
 *
 * `role` and `relatesTo` decide how the run page draws a number. A metric
 * declared `floor` is a property of the dataset, so it renders with no arrow;
 * the same row with the role missing renders "higher is better", which is
 * advice to raise a number the submission does not control. Both fields rode
 * the callback and were accepted by the wire schema, and then the writer
 * dropped them, so the page could never see them however correctly it was
 * written. That is a storage bug and it is only observable end to end.
 *
 * These go through the real route so the writer's own field mapping is what
 * is under test. Asserting against a hand-built row would pass with the
 * columns still unwired.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const SECRET = "test-signing-secret-that-is-long-enough";
const LANGUAGE = "language-search";

function freshDb(): { db: Database; binding: unknown } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const binding = {
    prepare(query: string) {
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
    },
    async batch(statements: { execute(): unknown }[]) {
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
  return { db: drizzle(binding as never) as unknown as Database, binding };
}

function env(binding: unknown): Env {
  return {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "modal",
    PUBLIC_ORIGIN: "https://portal.example",
    RUNNER_SIGNING_SECRET: SECRET,
  } as unknown as Env;
}

async function seedRun(db: Database, runId: string): Promise<void> {
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  await db.insert(teams).values({
    id: "team_1",
    cohortId: "cohort_test",
    name: "team_1",
    description: null,
    repoOwner: "cogworks-test",
    repoName: "team_1",
    repoFullName: "cogworks-test/team_1",
    repoUrl: "https://github.com/cogworks-test/team_1",
    defaultBranch: "main",
  });
  await db.insert(runs).values({
    id: runId,
    teamId: "team_1",
    benchmarkId: LANGUAGE,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    mode: "practice",
    status: "evaluating",
    branch: "main",
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
    provider: "modal",
    lastEventSequence: 0,
    surfaceId: null,
  });
}

async function post(binding: unknown, event: unknown): Promise<number> {
  const app = new Hono<AppEnv>();
  registerRunnerEventRoutes(app);
  app.onError(handleError);
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const response = await app.fetch(
    new Request("http://localhost:5173/internal/v1/runner/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Cogworks-Key-Id": "runner-v1",
        "X-Cogworks-Timestamp": timestamp,
        "X-Cogworks-Signature": `v1=${await hmacSignature(SECRET, timestamp, body)}`,
      },
      body,
    }),
    env(binding),
  );
  return response.status;
}

function completed(runId: string, metrics: unknown[], eventId = "evt_1", sequence = 5) {
  return {
    protocolVersion: "1",
    eventId,
    runId,
    sequence,
    occurredAt: NOW + 60_000,
    type: "completed",
    preparedArtifactId: "im-testsnapshot",
    environmentDigest: "b".repeat(64),
    sanitizedLog: null,
    result: {
      protocolVersion: "1",
      benchmarkId: LANGUAGE,
      benchmarkVersion: 1,
      metrics,
      diagnostics: [],
      outputDigest: "c".repeat(64),
    },
  };
}

const SCORED = {
  key: "retrieval_mrr",
  label: "Retrieval MRR",
  value: 0.2586,
  unit: null,
  higherIsBetter: true,
  primary: true,
  precision: 3,
};

const FLOOR = {
  key: "chance_mrr",
  label: "Chance MRR",
  value: 0.0102,
  unit: null,
  higherIsBetter: true,
  primary: false,
  precision: 3,
  help: "What ranking at random scores.",
  role: "floor",
  relatesTo: "retrieval_mrr",
};

async function metricsOf(db: Database, runId: string) {
  const rows = await db.select().from(runMetrics).where(eq(runMetrics.runId, runId));
  return new Map(rows.map((row) => [row.key, serializeMetric(row)]));
}

test("a declared floor keeps its role and its parent across storage", async () => {
  const { db, binding } = freshDb();
  await seedRun(db, "run_1");

  assert.equal(await post(binding, completed("run_1", [SCORED, FLOOR])), 200);

  const stored = await metricsOf(db, "run_1");
  const floor = stored.get("chance_mrr");
  assert.equal(floor?.role, "floor");
  assert.equal(floor?.relatesTo, "retrieval_mrr");
  // The direction the scorer sent is still recorded. The page suppresses the
  // arrow from the role, so storage must not quietly rewrite this too.
  assert.equal(floor?.higherIsBetter, true);
});

test("a metric that declares no role comes back with none, not a guessed one", async () => {
  const { db, binding } = freshDb();
  await seedRun(db, "run_2");

  assert.equal(await post(binding, completed("run_2", [SCORED])), 200);

  const stored = await metricsOf(db, "run_2");
  const scored = stored.get("retrieval_mrr");
  // Null, not "scored". A row written before this column existed has no
  // recorded role, and inventing one would be claiming evidence about a run
  // nobody can observe again. `chance_mrr` is a floor by name in three
  // benchmarks and the storage layer still must not say so.
  assert.equal(scored?.role, null);
  assert.equal(scored?.relatesTo, null);
});

test("a result arriving after the run finished does not rewrite its metadata", async () => {
  const { db, binding } = freshDb();
  await seedRun(db, "run_3");

  assert.equal(await post(binding, completed("run_3", [SCORED, FLOOR])), 200);
  assert.equal((await metricsOf(db, "run_3")).get("chance_mrr")?.role, "floor");

  // A later event carrying the same metric without its metadata. The run is
  // already succeeded, and applyEvent returns immediately on a terminal run
  // (routes/runner-events.ts), so this is accepted and applied to nothing.
  const { key, label, value, unit, higherIsBetter, primary, precision } = FLOOR;
  assert.equal(
    await post(
      binding,
      completed(
        "run_3",
        [SCORED, { key, label, value, unit, higherIsBetter, primary, precision }],
        "evt_2",
        6,
      ),
    ),
    200,
  );

  const after = (await metricsOf(db, "run_3")).get("chance_mrr");
  assert.equal(after?.role, "floor");
  assert.equal(after?.relatesTo, "retrieval_mrr");
});

test("a duplicate key inside one result is resolved by the last metric sent", () => {
  // The wire schema does not require metric keys to be unique inside one
  // result, so both branches of the upsert run within a single event: the
  // first insert, the second on conflict. That is the branch where writing
  // only the fields that arrived would leave the row asserting a role the
  // last metric did not declare.
  const scenarios = [
    { second: { ...FLOOR, role: undefined, relatesTo: undefined }, role: null, parent: null },
    { second: { ...FLOOR, role: "reported", relatesTo: "text_mrr" }, role: "reported", parent: "text_mrr" },
  ] as const;

  return scenarios.reduce(
    (chain, scenario, index) =>
      chain.then(async () => {
        const runId = `run_dup_${index}`;
        const { db, binding } = freshDb();
        await seedRun(db, runId);
        assert.equal(
          await post(binding, completed(runId, [SCORED, FLOOR, scenario.second])),
          200,
        );
        const stored = (await metricsOf(db, runId)).get("chance_mrr");
        assert.equal(stored?.role, scenario.role);
        assert.equal(stored?.relatesTo, scenario.parent);
      }),
    Promise.resolve(),
  );
});
