import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { RUN_PHASES } from "@cogworks/contracts/schema";
import type { Database } from "../worker/db/client.ts";
import { cohorts, outboxEvents, runPhases, runs, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { hmacSignature } from "../worker/execution/runner.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerRunnerEventRoutes } from "../worker/routes/runner-events.ts";

/**
 * The stale-run sweep judges an active execution by the server time of its
 * last accepted runner callback (0049), not by when it was created. These run
 * the real callback route and the real sweep against the migrations on SQLite.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const SECRET = "test-signing-secret-that-is-long-enough";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Batch = (statements: Array<{ execute(): unknown }>) => Promise<unknown[]>;

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const prepare = (query: string) => {
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
  };
  // D1 commits a batch as one transaction.
  const batch: Batch = async (statements) => {
    sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };
  const binding = { prepare, batch };
  return { db: drizzle(binding as never) as unknown as Database, binding };
}

function env(binding: unknown): Env {
  // SAFETY: the callback route and the sweep read only these bindings; the
  // sweep's Discord nudges catch their own failure.
  return { DB: binding, RUNNER_SIGNING_SECRET: SECRET, EXECUTION_PROVIDER: "modal" } as unknown as Env;
}

async function seed(db: Database) {
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values({ id: "user_1", name: "Student", email: "student@example.test", cohortId: "cohort_1" });
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Team", description: null, repoOwner: "course", repoName: "team",
    repoFullName: "course/team", repoUrl: "https://github.com/course/team", defaultBranch: "main", repoId: 7,
  });
}

async function run(db: Database, over: Partial<typeof runs.$inferInsert> & { id: string }) {
  const status = over.status ?? "evaluating";
  await db.insert(runs).values({
    teamId: "team_1", benchmarkId: "vision-recognition", benchmarkVersion: 2,
    contractVersion: "cogworks.submissions.v1", mode: "practice", branch: "main",
    sha: "a".repeat(40), repositoryId: 7, repositoryFullName: "course/team", provider: "modal",
    createdAt: Date.now() - 2 * HOUR, lastEventSequence: 1, legacyGraceUntil: 0, surfaceId: null,
    ...over, status,
  });
  // The run's own phase is the open one, as the callbacks that got it there leave it.
  await db.insert(runPhases).values(RUN_PHASES.map((phase) => ({
    runId: over.id, phase, startedAt: phase === status ? Date.now() - HOUR : null, endedAt: null,
  })));
}

async function openPhase(db: Database, runId: string) {
  const phases = await db.select().from(runPhases).where(eq(runPhases.runId, runId));
  return phases.find((phase) => phase.startedAt !== null && phase.endedAt === null)?.phase ?? null;
}

async function row(db: Database, id: string) {
  const [found] = await db.select().from(runs).where(eq(runs.id, id));
  assert.ok(found);
  return found;
}

async function callback(binding: unknown, event: Record<string, unknown>) {
  const app = new Hono<AppEnv>();
  registerRunnerEventRoutes(app);
  app.onError(handleError);
  const body = JSON.stringify({ protocolVersion: "1", occurredAt: Date.now(), ...event });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await app.fetch(new Request("http://localhost/internal/v1/runner/events", {
    method: "POST", body,
    headers: { "X-Cogworks-Key-Id": "runner-v1", "X-Cogworks-Timestamp": timestamp,
      "X-Cogworks-Signature": `v1=${await hmacSignature(SECRET, timestamp, body)}` },
  }), env(binding));
  assert.equal(response.status, 200, await response.text());
}

function heartbeat(runId: string, sequence: number) {
  return { type: "status", eventId: `evt_${runId}_${sequence}`, runId, sequence, status: "evaluating" };
}

test("a same-phase callback keeps a long evaluation alive until it goes quiet", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  await run(db, { id: "run_long" });

  await callback(binding, heartbeat("run_long", 2));
  const heard = (await row(db, "run_long")).acceptedActivityAt!;
  assert.ok(heard >= Date.now() - MINUTE, "the accepted callback was not recorded");

  await maintainPlatform(env(binding), Date.now());
  assert.equal((await row(db, "run_long")).status, "evaluating", "a run that reported a moment ago was failed");

  await maintainPlatform(env(binding), heard + HOUR + 1);
  assert.equal((await row(db, "run_long")).status, "failed");
});

test("a heartbeat that lands between the sweep's read and its write wins", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  await run(db, { id: "run_racing", acceptedActivityAt: Date.now() - HOUR - MINUTE });

  assert.equal(await openPhase(db, "run_racing"), "evaluating");
  // The sweep has selected the run as silent. Before its settlement batch
  // runs, the sandbox reports again in the same phase.
  let interleaved = false;
  const sweeping = {
    prepare: binding.prepare,
    batch: (async (statements) => {
      if (!interleaved) {
        interleaved = true;
        await callback(binding, heartbeat("run_racing", 2));
      }
      return binding.batch(statements);
    }) satisfies Batch,
  };
  await maintainPlatform(env(sweeping), Date.now());

  assert.ok(interleaved, "the sweep never reached its settlement");
  const after = await row(db, "run_racing");
  assert.equal(after.status, "evaluating", "a fresh same-phase heartbeat lost to the sweep");
  assert.equal(after.lastEventSequence, 2);
  assert.deepEqual(await db.select().from(outboxEvents), [], "a failure notice went out for a live run");
  assert.equal(await openPhase(db, "run_racing"), "evaluating", "the live run's open stage was closed");
});

test("replays, lower sequences and results for a failed run do not move the activity clock", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const earlier = Date.now() - 30 * MINUTE;
  await run(db, { id: "run_clock", acceptedActivityAt: earlier, lastEventSequence: 5 });

  await callback(binding, heartbeat("run_clock", 5));
  await callback(binding, heartbeat("run_clock", 3));
  assert.equal((await row(db, "run_clock")).acceptedActivityAt, earlier, "an ignored callback moved the clock");

  await callback(binding, heartbeat("run_clock", 6));
  const accepted = (await row(db, "run_clock")).acceptedActivityAt!;
  assert.ok(accepted > earlier);

  // A result that arrives after the run already failed is kept as history,
  // and is not activity.
  await db.update(runs).set({ status: "failed", finishedAt: Date.now() }).where(eq(runs.id, "run_clock"));
  await callback(binding, {
    type: "completed", eventId: "evt_run_clock_late", runId: "run_clock", sequence: 7,
    preparedArtifactId: "artifact_late", environmentDigest: "d".repeat(64), sanitizedLog: null,
    result: {
      protocolVersion: "1", benchmarkId: "vision-recognition", benchmarkVersion: 2,
      metrics: [{ key: "accuracy", label: "Accuracy", value: 0.5, unit: null, higherIsBetter: true, primary: true, precision: 2 }],
      diagnostics: [], outputDigest: "e".repeat(64),
    },
  });
  await callback(binding, heartbeat("run_clock", 8));
  assert.equal((await row(db, "run_clock")).acceptedActivityAt, accepted, "late evidence moved the clock");
});

test("queued keeps its ten minutes from creation", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  await run(db, { id: "run_lost", status: "queued", createdAt: Date.now() - 11 * MINUTE, lastEventSequence: -1 });
  // Another benchmark: one team holds one active run per benchmark.
  await run(db, {
    id: "run_waiting", benchmarkId: "vision-clustering", status: "queued",
    createdAt: Date.now() - 9 * MINUTE, lastEventSequence: -1,
  });

  await maintainPlatform(env(binding), Date.now());

  assert.equal((await row(db, "run_lost")).status, "failed");
  assert.equal((await row(db, "run_waiting")).status, "queued");
});

test("a run from before the clock gets one grace window, once, and a callback in it counts", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  // Already running when 0049 shipped: no activity recorded, grace not set.
  const created = Date.now() - 3 * HOUR;
  await run(db, { id: "run_legacy", createdAt: created, legacyGraceUntil: null });
  await run(db, { id: "run_legacy_alive", benchmarkId: "vision-clustering", createdAt: created, legacyGraceUntil: null });
  const first = Date.now();

  await maintainPlatform(env(binding), first);
  for (const id of ["run_legacy", "run_legacy_alive"]) {
    const legacy = await row(db, id);
    assert.equal(legacy.status, "evaluating", `${id} was failed by age alone`);
    assert.equal(legacy.legacyGraceUntil, first + HOUR);
  }

  // Later sweeps inside the window cannot extend it.
  await maintainPlatform(env(binding), first + 30 * MINUTE);
  assert.equal((await row(db, "run_legacy")).legacyGraceUntil, first + HOUR);

  // One of them reports during its grace; from then on its activity decides.
  await callback(binding, heartbeat("run_legacy_alive", 2));

  await maintainPlatform(env(binding), first + HOUR + 1);
  assert.equal((await row(db, "run_legacy")).status, "failed");
  assert.equal((await row(db, "run_legacy_alive")).status, "evaluating");
  assert.equal((await row(db, "run_legacy")).legacyGraceUntil, first + HOUR);
});

test("a higher sequence read before a lower one committed does not move the clock back", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  await run(db, { id: "run_order" });

  // Sequence 3 takes its receive time, then waits on its read of the run.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  let pausedOnce = false;
  const pausing = {
    batch: binding.batch,
    prepare(query: string) {
      const statement = binding.prepare(query);
      if (pausedOnce || !/^select "id", "team_id"/i.test(query)) return statement;
      pausedOnce = true;
      const original = statement.all.bind(statement);
      const raw = statement.raw.bind(statement);
      return Object.assign(statement, {
        async all() { reached(); await held; return original(); },
        async raw() { reached(); await held; return raw(); },
      });
    },
  };
  const later = callback(pausing, heartbeat("run_order", 3));
  await paused;
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Sequence 2 arrives afterwards and commits first.
  await callback(binding, heartbeat("run_order", 2));
  const newest = (await row(db, "run_order")).acceptedActivityAt!;
  release();
  await later;

  const after = await row(db, "run_order");
  assert.equal(after.lastEventSequence, 3);
  assert.equal(after.acceptedActivityAt, newest, "the older receive time replaced the newer one");
});
