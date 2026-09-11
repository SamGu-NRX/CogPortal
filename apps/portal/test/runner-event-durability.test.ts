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
import { cohorts, leaderboardSelections, officialAttempts, outboxEvents, runEvents, runMetrics, runPhases, runs, teams } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { serializeRunDetail } from "../worker/http/serializers.ts";
import { publishOfficialRun, type RunActor } from "../worker/services/run-actions.ts";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";

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
  /** Hold the first matching read's captured rows until the test releases it. */
  pauseAfterRead(pattern: RegExp): { reached: Promise<void>; release(): void };
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
  let readBarrier: { pattern: RegExp; reached(): void; released: Promise<void> } | null = null;

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
        if (readBarrier?.pattern.test(query)) {
          const barrier = readBarrier;
          readBarrier = null;
          barrier.reached();
          await barrier.released;
        }
        return rows;
      },
    };
    return prepared;
  }

  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
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
  return {
    db: drizzle(binding as never) as unknown as Database,
    binding,
    pauseAfterRead(pattern) {
      let signalReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => { signalReached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      readBarrier = { pattern, reached: signalReached, released };
      return { reached, release };
    },
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
  // Retry at the cap boundary without counting this refund twice.
  await priorRefunds(harness.db, 4);
  const app = route();
  const event = infrastructureFailureEvent();

  // The refund transaction committed, but the terminal callback did not.
  harness.interruptOn(/insert into "outbox_events"/i);
  const first = await post(app, harness.binding, event);
  assert.equal(first.status, 500);

  const midway = await counts(harness.db);
  assert.equal(midway.attempts, 0, "the claim was given back");
  assert.notEqual(midway.run?.refundedAt, null, "the refund was recorded in the same transaction");
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

async function publicationActor(db: Database): Promise<RunActor> {
  await db.update(teams).set({ repoFullName: FIXTURE_REPO.fullName }).where(eq(teams.id, "team_1"));
  const [team] = await db.select().from(teams).where(eq(teams.id, "team_1"));
  return { userId: "test_user", githubLogin: null, role: "write", team };
}

for (const mode of ["practice", "official"] as const) {
  test(`the reaper's ${mode} failure preserves a late completed result and its settlement`, async () => {
    const harness = freshHarness();
    await seedRun(harness.db, { mode });
    const app = route();
    await maintainPlatform(env(harness.binding), NOW + 3_600_001);
    const reaped = await counts(harness.db);
    assert.equal(reaped.run.status, "failed");
    assert.equal(reaped.attempts, 0);

    const response = await post(app, harness.binding, completedEvent());
    assert.equal(response.status, 200);
    const recovered = await counts(harness.db);
    assert.equal(recovered.run.status, "succeeded");
    assert.equal(recovered.metrics, 2);
    assert.equal(recovered.run.failureCategory, null);
    assert.equal(recovered.run.failureDetail, null);
    assert.equal(recovered.run.refundedAt, reaped.run.refundedAt);
    assert.equal(recovered.attempts, 0);
    assert.deepEqual(JSON.parse(recovered.run.diagnosticsJson!), ["the first note", "the second note"]);
    const actor = await publicationActor(harness.db);
    const detail = await serializeRunDetail(harness.db, recovered.run, actor.team);
    assert.equal(detail.publishable, false);
    await assert.rejects(publishOfficialRun(env(harness.binding), actor, "run_1"), { code: "not_selectable" });
    assert.equal((await harness.db.select().from(leaderboardSelections)).length, 0);

    const retry = await post(app, harness.binding, completedEvent());
    assert.equal(retry.body.duplicate, true);
    await maintainPlatform(env(harness.binding), NOW + 7_200_000);
    assert.deepEqual(await counts(harness.db), recovered);
  });
}

test("a refunded late completion cannot replace a subsequently published official run or reclaim its attempt", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();
  await maintainPlatform(env(harness.binding), NOW + 3_600_001);
  const reaped = await counts(harness.db);
  await harness.db.insert(runs).values({
    ...reaped.run,
    id: "run_2",
    status: "evaluating",
    createdAt: NOW + 3_600_002,
    finishedAt: null,
    refundedAt: null,
    failureCategory: null,
    failurePhase: null,
    failureDetail: null,
    lastEventSequence: 0,
  });
  await harness.db.insert(officialAttempts).values({
    id: "attempt_run_2",
    teamId: "team_1",
    benchmarkId: AUDIO,
    benchmarkVersion: 1,
    runId: "run_2",
    attemptNumber: 1,
    consumed: false,
    claimedAt: NOW + 3_600_002,
  });
  assert.equal((await post(app, harness.binding, {
    protocolVersion: "1",
    eventId: "evt_evaluating_2",
    runId: "run_2",
    sequence: 1,
    occurredAt: NOW + 3_600_003,
    type: "status",
    status: "evaluating",
  })).status, 200);
  assert.equal((await post(app, harness.binding, {
    ...completedEvent(),
    runId: "run_2",
    eventId: "evt_completed_2",
    occurredAt: NOW + 3_660_000,
  })).status, 200);
  const actor = await publicationActor(harness.db);
  await publishOfficialRun(env(harness.binding), actor, "run_2");
  const selection = await harness.db.select().from(leaderboardSelections);
  const attempts = await harness.db.select().from(officialAttempts);
  assert.equal(selection[0].runId, "run_2");
  assert.equal(attempts[0].consumed, true);

  assert.equal((await post(app, harness.binding, completedEvent())).status, 200);
  const recovered = await counts(harness.db);
  assert.equal(recovered.run.status, "succeeded");
  assert.equal(recovered.metrics, 2);
  assert.equal(recovered.run.refundedAt, reaped.run.refundedAt);
  assert.equal(recovered.attempts, 0);
  await assert.rejects(publishOfficialRun(env(harness.binding), actor, "run_1"), { code: "not_selectable" });
  assert.equal((await post(app, harness.binding, completedEvent())).body.duplicate, true);
  await maintainPlatform(env(harness.binding), NOW + 7_200_000);
  assert.deepEqual(await harness.db.select().from(leaderboardSelections), selection);
  assert.deepEqual(await harness.db.select().from(officialAttempts), attempts);
});

test("out-of-order status callbacks cannot reopen a reaped run or block its late result", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  const app = route();
  await maintainPlatform(env(harness.binding), NOW + 3_600_001);
  const reaped = await counts(harness.db);
  for (const sequence of [4, 2]) {
    assert.equal((await post(app, harness.binding, {
      protocolVersion: "1",
      eventId: `evt_status_${sequence}`,
      runId: "run_1",
      sequence,
      occurredAt: NOW + sequence * 1_000,
      type: "status",
      status: "evaluating",
    })).status, 200);
    const after = await counts(harness.db);
    assert.deepEqual(after.run, reaped.run);
    assert.equal(after.attempts, 0);
  }
  assert.equal((await post(app, harness.binding, completedEvent())).status, 200);
  const recovered = await counts(harness.db);
  assert.equal(recovered.run.status, "succeeded");
  assert.equal(recovered.run.lastEventSequence, 5);
  assert.equal(recovered.run.refundedAt, reaped.run.refundedAt);
  assert.equal(recovered.metrics, 2);
  assert.equal(recovered.attempts, 0);
});

for (const status of ["evaluating", "scoring"] as const) {
  for (const capped of [false, true]) {
    test(`${status} callback read before reaping preserves the ${capped ? "capped" : "refunded"} terminal state`, { timeout: 5_000 }, async () => {
      const harness = freshHarness();
      await seedRun(harness.db);
      await harness.db.update(runs).set({ status: "contract_check" }).where(eq(runs.id, "run_1"));
      await harness.db.insert(runPhases).values([
        { runId: "run_1", phase: "contract_check", startedAt: NOW + 1_000, endedAt: null },
        { runId: "run_1", phase: "evaluating", startedAt: null, endedAt: null },
        { runId: "run_1", phase: "scoring", startedAt: null, endedAt: null },
      ]);
      if (capped) await priorRefunds(harness.db, 5);
      const snapshot = async () => ({
        run: (await counts(harness.db)).run,
        attempts: await harness.db.select().from(officialAttempts),
        phases: await harness.db.select().from(runPhases),
      });
      // Skip the route's id-only existence check. Hold applyEvent's full run
      // snapshot after SQLite has read it, before Drizzle returns it to the caller.
      const barrier = harness.pauseAfterRead(/^select "id", "team_id", .* from "runs"/i);
      const app = route();
      const event = {
        protocolVersion: "1", eventId: "evt_racing_status", runId: "run_1",
        sequence: 4, occurredAt: NOW + 60_000, type: "status", status,
      };
      const pending = post(app, harness.binding, event);
      await barrier.reached;
      let reaped: Awaited<ReturnType<typeof snapshot>>;
      try {
        await maintainPlatform(env(harness.binding), NOW + 3_600_001);
        reaped = await snapshot();
        assert.equal(reaped.run.status, "failed");
        assert.equal(reaped.attempts.length, capped ? 1 : 0);
        assert.equal(reaped.run.refundedAt === null, capped);
      } finally {
        barrier.release();
      }
      assert.equal((await pending).status, 200);
      assert.deepEqual(await snapshot(), reaped);
      assert.equal((await post(app, harness.binding, event)).body.duplicate, true);
      assert.deepEqual(await snapshot(), reaped);
      assert.equal((await counts(harness.db)).events, 1);
    });
  }
}

test("a capped stale run retains its spent attempt and remains publishable", async () => {
  const harness = freshHarness();
  await seedRun(harness.db);
  await priorRefunds(harness.db, 5);
  await maintainPlatform(env(harness.binding), NOW + 3_600_001);
  const reaped = await counts(harness.db);
  assert.equal(reaped.run.refundedAt, null);
  assert.equal(reaped.attempts, 1);
  assert.equal((await post(route(), harness.binding, completedEvent())).status, 200);
  const recovered = await counts(harness.db);
  const actor = await publicationActor(harness.db);
  assert.equal((await serializeRunDetail(harness.db, recovered.run, actor.team)).publishable, true);
  await publishOfficialRun(env(harness.binding), actor, "run_1");
  assert.equal((await harness.db.select().from(leaderboardSelections))[0].runId, "run_1");
  assert.equal((await counts(harness.db)).attempts, 1);
});

for (const status of ["cancelled", "failed"] as const) {
  test(`a late completion cannot replace a ${status} runner outcome`, async () => {
    const harness = freshHarness();
    await seedRun(harness.db);
    if (status === "failed") {
      const failure = infrastructureFailureEvent();
      failure.failure.category = "scorer";
      assert.equal((await post(route(), harness.binding, failure)).status, 200);
    } else {
      await harness.db.update(runs).set({ status }).where(eq(runs.id, "run_1"));
    }
    const event = { ...completedEvent(), sequence: 6 };
    assert.equal((await post(route(), harness.binding, event)).status, 200);
    const after = await counts(harness.db);
    assert.equal(after.run.status, status);
    assert.equal(after.metrics, 0);
  });
}
