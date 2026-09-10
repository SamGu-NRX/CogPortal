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
import { cohorts, officialAttempts, outboxEvents, runEvents, runMetrics, runs, teams } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";

/**
 * What the portal is allowed to say when it answers a runner event.
 *
 * `{"duplicate": true}` is the portal telling the runner to stop resending.
 * The runner believes it: `_finish` in the Modal app records the event as
 * delivered and a later attempt replays nothing. So the record that produces
 * that answer must not exist unless the result behind it was actually applied.
 *
 * It used to be written first. A thrown error was repaired by deleting it
 * again, which covers an error the process lives to handle and nothing else. A
 * Worker evicted mid-request, or past its CPU limit, leaves the record with no
 * result behind it and no later moment when the repair runs. Every retry then
 * reads the record and is told the result is already in, while the run sits
 * unfinished until the stale sweep fails it. In official mode that spends an
 * attempt on a result the portal was holding the whole time.
 *
 * These tests interrupt the handler partway through applying an event and then
 * replay the same event through the same route, which is the only way to tell
 * a truthful acknowledgement from a premature one.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const SECRET = "test-signing-secret-that-is-long-enough";
const AUDIO = "audio-identification";

/**
 * A D1-shaped binding over in-process SQLite, with one addition: a trap that
 * throws on a chosen statement, once.
 *
 * The trap is armed on SQL text rather than a statement count. A count drifts
 * the moment anyone reads another column; the text names the write the test
 * means. It disarms itself so the request that follows the interruption runs
 * against an ordinary database, which is what a retry meets in production.
 *
 * `getDb` builds a fresh drizzle handle from `env.DB` on every call and never
 * memoizes, so passing this as `env.DB` to `app.fetch` puts every statement
 * the handler issues, including the ones inside `applyEvent`, through here.
 * No seam is added to production code to make that work.
 */
interface Harness {
  db: Database;
  binding: unknown;
  /** Throw on the first statement whose SQL matches, then disarm. */
  interruptOn(pattern: RegExp): void;
  /** Throw on the Nth statement whose SQL matches, then disarm. */
  interruptOnNth(pattern: RegExp, nth: number): void;
  /**
   * Run a probe at the moment a matching statement is issued, without
   * disturbing it. This is how a test sees the database mid-apply, which is
   * the only way to observe the property the ordering is for.
   */
  observeAt(pattern: RegExp, probe: (sqlite: DatabaseSync) => void): void;
}

function freshHarness(): Harness {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    // Fixture rows would pollute the row counts these tests assert on.
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));

  let trap: ((sql: string) => boolean) | null = null;
  let observer: ((sql: string) => void) | null = null;

  function prepare(query: string) {
    observer?.(query);
    if (trap?.(query)) {
      trap = null;
      throw new Error("d1 interrupted");
    }
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

  const binding = { prepare };
  return {
    db: drizzle(binding as never) as unknown as Database,
    binding,
    interruptOn(pattern) {
      trap = (sql) => pattern.test(sql);
    },
    interruptOnNth(pattern, nth) {
      let seen = 0;
      trap = (sql) => pattern.test(sql) && ++seen === nth;
    },
    observeAt(pattern, probe) {
      observer = (sql) => {
        if (!pattern.test(sql)) return;
        observer = null;
        probe(sqlite);
      };
    },
  };
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

function route(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  registerRunnerEventRoutes(app);
  app.onError(handleError);
  return app;
}

/**
 * Posts an event the way the runner does.
 *
 * The body string is built once and used for both the signature and the
 * request. The handler signs over `await c.req.text()` and then parses that
 * same string, so re-serializing between the two would not match.
 */
async function post(
  app: Hono<AppEnv>,
  binding: unknown,
  event: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** An official run mid-flight, the state a completed event arrives against. */
async function seedRun(db: Database, options: { mode?: "practice" | "official" } = {}): Promise<void> {
  const mode = options.mode ?? "official";
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
    id: "run_1",
    teamId: "team_1",
    benchmarkId: AUDIO,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    mode,
    status: "evaluating",
    branch: "main",
    sha: "a".repeat(40),
    repositoryId: null,
    parentRunId: null,
    attemptNumber: mode === "official" ? 1 : null,
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
    // Null on purpose: the run-stream publish is gated on it, so leaving it
    // null keeps these tests off the Durable Object binding entirely.
    surfaceId: null,
  });
  if (mode !== "official") return;
  await db.insert(officialAttempts).values({
    id: "attempt_run_1",
    teamId: "team_1",
    benchmarkId: AUDIO,
    benchmarkVersion: 1,
    runId: "run_1",
    attemptNumber: 1,
    consumed: false,
    claimedAt: NOW,
  });
}

function completedEvent() {
  return {
    protocolVersion: "1",
    eventId: "evt_completed_1",
    runId: "run_1",
    sequence: 5,
    occurredAt: NOW + 60_000,
    type: "completed",
    preparedArtifactId: "im-testsnapshot",
    environmentDigest: "b".repeat(64),
    sanitizedLog: null,
    result: {
      protocolVersion: "1",
      benchmarkId: AUDIO,
      benchmarkVersion: 1,
      metrics: [
        {
          key: "overall",
          label: "Overall",
          value: 0.5375,
          unit: null,
          higherIsBetter: true,
          primary: true,
          precision: 4,
        },
        {
          key: "recall",
          label: "Recall",
          value: 0.61,
          unit: null,
          higherIsBetter: true,
          primary: false,
          precision: 4,
        },
      ],
      diagnostics: ["the first note", "the second note"],
      outputDigest: "c".repeat(64),
    },
  };
}

/** A failure that is ours, so the attempt goes back. */
function infrastructureFailureEvent() {
  return {
    protocolVersion: "1",
    eventId: "evt_failed_1",
    runId: "run_1",
    sequence: 5,
    occurredAt: NOW + 60_000,
    type: "failed",
    preparedArtifactId: null,
    environmentDigest: null,
    sanitizedLog: null,
    failure: {
      category: "provider",
      phase: "evaluating",
      detail: "the sandbox went away",
      infrastructure: true,
    },
  };
}

/** Runs already refunded for this team on this benchmark. */
async function priorRefunds(db: Database, howMany: number): Promise<void> {
  for (let index = 0; index < howMany; index += 1) {
    await db.insert(runs).values({
      id: `run_prior_${index}`,
      teamId: "team_1",
      benchmarkId: AUDIO,
      benchmarkVersion: 1,
      contractVersion: "cogworks.submissions.v1",
      mode: "official",
      status: "failed",
      branch: "main",
      sha: "a".repeat(40),
      repositoryId: null,
      parentRunId: null,
      attemptNumber: index + 2,
      failureCategory: "provider",
      failurePhase: "evaluating",
      failureDetail: null,
      failureConsumedAttempt: false,
      refundedAt: NOW - 1_000,
      log: null,
      createdAt: NOW - 10_000,
      finishedAt: NOW - 5_000,
      provider: "modal",
      lastEventSequence: 9,
      surfaceId: null,
    });
  }
}

async function counts(db: Database) {
  const [run] = await db.select().from(runs).where(eq(runs.id, "run_1")).limit(1);
  return {
    run,
    metrics: (await db.select().from(runMetrics).where(eq(runMetrics.runId, "run_1"))).length,
    events: (await db.select().from(runEvents).where(eq(runEvents.runId, "run_1"))).length,
    outbox: (await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "run_1"))).length,
    attempts: (await db.select().from(officialAttempts).where(eq(officialAttempts.runId, "run_1"))).length,
  };
}

test("no record exists while the result is still being applied", async () => {
  // The property the ordering exists for, and the only one a thrown error
  // cannot demonstrate. Interrupting with an exception is handled by a catch;
  // a Worker that is evicted is not, and no test can evict a Worker. What can
  // be observed is whether the row that answers "we already have this" is
  // present during the window where the answer would be a lie.
  //
  // Recording first put the row in before the work. Anything that stopped the
  // process in this window left it there for good. Applying first means there
  // is nothing to leave behind.
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();

  let recordedMidApply: number | null = null;
  harness.observeAt(/insert into "run_metrics"/i, (sqlite) => {
    const [row] = sqlite.prepare('select count(*) as n from run_events').all() as { n: number }[];
    recordedMidApply = row.n;
  });

  const response = await post(app, harness.binding, completedEvent());
  assert.equal(response.status, 200);
  assert.equal(
    recordedMidApply,
    0,
    "a request arriving mid-apply would have been told the result was already in",
  );
});

test("an interrupted apply records nothing, so the replay is not told the result is already in", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();
  const event = completedEvent();

  // Die between the two metric writes: far enough in that some of the result
  // is on disk, not far enough to have finished.
  harness.interruptOnNth(/insert into "run_metrics"/i, 2);
  const first = await post(app, harness.binding, event);
  assert.equal(first.status, 500);

  const midway = await counts(harness.db);
  assert.equal(midway.metrics, 1, "the apply really was interrupted partway");
  assert.equal(midway.run?.status, "evaluating", "and did not reach the terminal write");
  assert.equal(
    midway.events,
    0,
    "nothing was recorded, so no later request can be answered with duplicate",
  );

  const replay = await post(app, harness.binding, event);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, false, "the replay applied the result rather than skipping it");

  const after = await counts(harness.db);
  assert.equal(after.run?.status, "succeeded");
  assert.equal(after.run?.lastEventSequence, 5);
  assert.equal(after.metrics, 2, "both metrics, one row each");
  assert.equal(after.outbox, 1, "one terminal outbox row");
  assert.equal(after.events, 1);
  assert.deepEqual(JSON.parse(after.run?.diagnosticsJson ?? "[]"), ["the first note", "the second note"]);
});

test("replaying a result that already landed changes nothing and says so", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();
  const event = completedEvent();

  const first = await post(app, harness.binding, event);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  const once = await counts(harness.db);

  const again = await post(app, harness.binding, event);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true, "now the acknowledgement is truthful");

  const twice = await counts(harness.db);
  assert.deepEqual(
    { metrics: twice.metrics, outbox: twice.outbox, events: twice.events },
    { metrics: once.metrics, outbox: once.outbox, events: once.events },
  );
  assert.equal(twice.run?.status, "succeeded");
  assert.equal(twice.run?.finishedAt, once.run?.finishedAt);
});

test("a result already applied is not lost when recording it fails", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();
  const event = completedEvent();

  // The window the old order could not survive. Recording first and applying
  // second meant a death here left a record with nothing behind it, and the
  // repair that deleted it could die too, wedging the run at duplicate for
  // good. Applying first turns this into an ordinary retry.
  harness.interruptOn(/insert into "run_events"/i);
  const first = await post(app, harness.binding, event);
  assert.equal(first.status, 500);

  const midway = await counts(harness.db);
  assert.equal(midway.run?.status, "succeeded", "the result was applied before the failure");
  assert.equal(midway.metrics, 2);
  assert.equal(midway.events, 0);

  const replay = await post(app, harness.binding, event);
  assert.equal(replay.status, 200);

  const after = await counts(harness.db);
  assert.equal(after.metrics, 2, "re-applying a finished run added no rows");
  assert.equal(after.outbox, 1);
  assert.equal(after.events, 1, "and the event is recorded now");
});

test("an interrupted refund settles the attempt exactly once across the replay", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  // Four refunds already given on this benchmark, one below the cap of five.
  // At this boundary the `ne(runs.id, run.id)` exclusion in refunds.ts is
  // load-bearing: a decision that counted the run being decided would read
  // five and cap it, and the assertions below would see a cap notice.
  await priorRefunds(harness.db, 4);
  const app = route();
  const event = infrastructureFailureEvent();

  // Between the attempt-row delete and the refunded_at mark, which is the
  // non-atomic window execution/refunds.ts documents.
  harness.interruptOn(/update "runs" set "refunded_at"/i);
  const first = await post(app, harness.binding, event);
  assert.equal(first.status, 500);

  const midway = await counts(harness.db);
  assert.equal(midway.attempts, 0, "the claim was given back");
  assert.equal(midway.run?.refundedAt, null, "but the refund was not recorded yet");
  assert.equal(midway.events, 0);

  const replay = await post(app, harness.binding, event);
  assert.equal(replay.status, 200);

  const after = await counts(harness.db);
  assert.equal(after.attempts, 0, "still one settlement, not two");
  assert.notEqual(after.run?.refundedAt, null, "recorded exactly once by the replay");
  assert.equal(after.run?.status, "failed");
  assert.equal(after.run?.failureConsumedAttempt, false);
  assert.equal(
    after.run?.failureDetail,
    "the sandbox went away",
    "no cap notice: the run does not count itself toward its own cap",
  );

  const third = await post(app, harness.binding, event);
  assert.equal(third.body.duplicate, true);
  const settled = await counts(harness.db);
  assert.equal(settled.attempts, 0);
  assert.equal(settled.run?.refundedAt, after.run?.refundedAt, "the third post moved nothing");
});

test("two deliveries of one event racing each other settle it once", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();
  const event = completedEvent();

  const [a, b] = await Promise.all([
    post(app, harness.binding, event),
    post(app, harness.binding, event),
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(
    [a, b].filter((response) => response.body.duplicate === false).length,
    1,
    "exactly one of them recorded the event",
  );

  const after = await counts(harness.db);
  assert.equal(after.metrics, 2, "one row per metric key, not two");
  assert.equal(after.outbox, 1, "one terminal outbox row");
  assert.equal(after.events, 1);
  assert.equal(after.run?.status, "succeeded");
});
