import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "../worker/db/client.ts";
import type { Env } from "../worker/env.ts";
import { cohorts, outboxEvents, runPhases, runs, teams } from "../worker/db/schema.ts";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { readRunAccounting } from "../worker/services/run-accounting.ts";
import { syncRun } from "../worker/execution/sync.ts";

// Exercise real SQLite transactions through the same D1 methods as the Worker.
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** A D1-shaped binding plus the drizzle handle these tests read it through. */
interface Harness {
  db: Database;
  /** What a worker Env carries as `DB`. maintainPlatform takes the Env. */
  binding: unknown;
  sqlite: DatabaseSync;
}

function freshDb(): Harness {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    // Keep quota assertions independent of demo rows.
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));

  function prepare(query: string) {
    const statement = sqlite.prepare(query);
    let bound: SQLInputValue[] = [];
    const prepared = {
      bind(...params: SQLInputValue[]) {
        bound = params;
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
  }
  const binding = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      // Keep execution synchronous inside the transaction, as D1 serializes
      // batches rather than interleaving their statements across requests.
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
  // SAFETY: the binding implements the D1 methods Drizzle uses here, without
  // Cloudflare-only methods such as database export or sessions.
  return { db: drizzle(binding as never), binding, sqlite };
}

function maintenanceEnv(binding: Harness["binding"], staleAfterSeconds?: string): Env {
  // SAFETY: maintenance reads DB and the optional stale threshold. Discord
  // delivery returns without network access when its token is absent.
  return { DB: binding, RUN_STALE_AFTER_SECONDS: staleAfterSeconds } as Env;
}

const NOW = 1_780_000_000_000;
const VISION = "vision-recognition";

/** A fixture branch with a scripted missing-adapter failure. */
const PLATFORM_FAILURE_BRANCH = "missing-adapter";
/** Long enough past createdAt that every fixture phase has elapsed. */
const FIXTURE_RUN_MS = 30_000;

async function seedTeams(db: Database, teamIds: string[]): Promise<void> {
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  for (const id of teamIds) {
    await db.insert(teams).values({
      id,
      cohortId: "cohort_test",
      name: id,
      description: null,
      repoOwner: "cogworks-test",
      repoName: id,
      repoFullName: `cogworks-test/${id}`,
      repoUrl: `https://github.com/cogworks-test/${id}`,
      defaultBranch: "main",
    });
  }
}

interface RunOptions {
  id: string;
  teamId: string;
  benchmarkId?: string;
  benchmarkVersion?: number;
  mode?: "practice" | "official";
  status?: "queued" | "preparing" | "failed" | "succeeded" | "cancelled";
  branch?: string;
  provider?: "fixture" | "modal";
  createdAt?: number;
  failureDetail?: string | null;
  /** Set to mark this run as already refunded, the way a real refund does. */
  refundedAt?: number | null;
}

async function seedRun(db: Database, options: RunOptions): Promise<void> {
  const mode = options.mode ?? "official";
  const benchmarkId = options.benchmarkId ?? VISION;
  await db.insert(runs).values({
    id: options.id,
    teamId: options.teamId,
    benchmarkId,
    benchmarkVersion: options.benchmarkVersion ?? 1,
    contractVersion: "cogworks.submissions.v1",
    mode,
    status: options.status ?? "queued",
    branch: options.branch ?? PLATFORM_FAILURE_BRANCH,
    sha: "a".repeat(40),
    repositoryId: null,
    parentRunId: null,
    attemptNumber: mode === "official" ? 1 : null,
    failureCategory: null,
    failurePhase: null,
    failureDetail: options.failureDetail ?? null,
    failureConsumedAttempt: false,
    refundedAt: options.refundedAt ?? null,
    log: null,
    createdAt: options.createdAt ?? NOW,
    finishedAt: null,
    provider: options.provider ?? "fixture",
    lastEventSequence: -1,
    surfaceId: null,
  });
}

async function runRow(db: Database, runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  assert.ok(row, `run ${runId} is missing`);
  return row;
}

for (const mode of ["practice", "official"] as const) {
  for (const branch of [PLATFORM_FAILURE_BRANCH, "heavy-model"]) {
    test(`${mode} fixture ${branch} failure leaves no charged evaluation or reservation`, async () => {
      const { db } = freshDb();
      await seedTeams(db, ["team_a"]);
      await seedRun(db, { id: "run_1", teamId: "team_a", mode, branch });
      const row = await runRow(db, "run_1");
      const failed = await syncRun(db, row, NOW + FIXTURE_RUN_MS);
      assert.equal(failed.status, "failed");
      assert.equal(failed.failureConsumedAttempt, false);
      assert.equal(failed.refundedAt, null);
      assert.deepEqual(await readRunAccounting(db, { teamId: "team_a", allBenchmarks: true }), {
        practiceUsed: 0, officialUsed: 0, practiceReserved: 0, officialReserved: 0, activeRuns: 0,
      });
      assert.deepEqual(await syncRun(db, row, NOW + 1_000), failed, "a stale poll cannot revive the failure");
    });
  }

  test(`${mode} reaper failure releases capacity and remains terminal on repeated ticks`, async () => {
    const { db, binding } = freshDb();
    await seedTeams(db, ["team_a"]);
    await seedRun(db, { id: "run_1", teamId: "team_a", mode, provider: "modal", status: "preparing" });
    await maintainPlatform(maintenanceEnv(binding, "900"), NOW + 900_001);
    const failed = await runRow(db, "run_1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureConsumedAttempt, false);
    assert.deepEqual(await readRunAccounting(db, { teamId: "team_a", allBenchmarks: true }), {
      practiceUsed: 0, officialUsed: 0, practiceReserved: 0, officialReserved: 0, activeRuns: 0,
    });
    await maintainPlatform(maintenanceEnv(binding, "900"), NOW + 1_800_000);
    assert.deepEqual(await runRow(db, "run_1"), failed);
  });
}

test("repeated submission failures have no arbitrary refund limit", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  for (let index = 1; index <= 7; index += 1) {
    const id = `run_${index}`;
    await seedRun(db, { id, teamId: "team_a", branch: "heavy-model" });
    const failed = await syncRun(db, await runRow(db, id), NOW + FIXTURE_RUN_MS);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureConsumedAttempt, false);
  }
});

for (const path of ["fixture", "reaper"] as const) {
  test(`${path} terminal write failure rolls back earlier phase or outbox writes`, async () => {
    const { db, binding, sqlite } = freshDb();
    await seedTeams(db, ["team_a"]);
    await seedRun(db, { id: "run_1", teamId: "team_a", provider: path === "fixture" ? "fixture" : "modal" });
    const before = await runRow(db, "run_1");
    sqlite.exec(`CREATE TRIGGER interrupt_terminal BEFORE UPDATE OF status ON runs
      BEGIN SELECT RAISE(ABORT, 'terminal write interrupted'); END`);
    const settle = () => path === "fixture"
      ? syncRun(db, before, NOW + FIXTURE_RUN_MS)
      : maintainPlatform(maintenanceEnv(binding, "900"), NOW + 900_001);
    await assert.rejects(settle());
    assert.deepEqual(await runRow(db, "run_1"), before);
    assert.deepEqual(await db.select().from(runPhases), []);
    assert.deepEqual(await db.select().from(outboxEvents), []);
    sqlite.exec("DROP TRIGGER interrupt_terminal");
    await settle();
    assert.equal((await runRow(db, "run_1")).status, "failed");
    assert.equal((await db.select().from(outboxEvents)).length, path === "reaper" ? 1 : 0);
    assert.equal((await db.select().from(runPhases)).length > 0, path === "fixture");
  });
}

test("a queued execution is reaped at the existing ten-minute threshold", async () => {
  const { db, binding } = freshDb();
  await seedTeams(db, ["team_a"]);
  await seedRun(db, { id: "run_1", teamId: "team_a", provider: "modal" });
  await maintainPlatform(maintenanceEnv(binding), NOW + 600_000);
  assert.equal((await runRow(db, "run_1")).status, "queued");
  await maintainPlatform(maintenanceEnv(binding), NOW + 600_001);
  assert.equal((await runRow(db, "run_1")).status, "failed");
});
