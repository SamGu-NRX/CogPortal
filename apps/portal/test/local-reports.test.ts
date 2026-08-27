import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  localReports,
  teamMembers,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { listTeamLocalReports } from "../worker/services/local-reports.ts";

/**
 * A benchmark bump keeps the id and raises the version. The team list
 * filtered by id only, so a report synced against v1 kept appearing in the
 * v2 dashboard as if it were current work. The list must pin to the active
 * version, resolved the same way the dashboard route resolves it (active
 * flag, highest version).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/* In-process SQLite behind the surface drizzle's d1 driver calls, built from
 * the same migration files that run against D1. Same harness as
 * refund-cap.test.ts; the seed/backfill migrations are skipped so the
 * benchmark rows here are exactly the ones each test writes. */
function freshBinding(): unknown {
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
  return { prepare };
}

// Not a shipped benchmark id: the week migrations insert real rows for those
// (0013/0018/0020), and this test owns exactly the versions it writes.
const BENCHMARK = "test-only-benchmark";
const REPO = "demo-org/team-repo";

function benchmarkRow(version: number, active: boolean) {
  return {
    id: BENCHMARK,
    version,
    contractVersion: "1",
    entryPointName: "solve",
    title: "Vision Recognition",
    module: "vision" as const,
    summary: "Test benchmark",
    active,
    primaryMetricKey: "accuracy",
  };
}

function reportRow(reportId: string, benchmarkVersion: number) {
  return {
    reportId,
    userId: "user_1",
    benchmarkId: BENCHMARK,
    benchmarkVersion,
    contractVersion: "1",
    sdkVersion: "0.1.0",
    pluginVersion: "0.1.0",
    repositoryId: 1,
    repositoryFullName: REPO,
    sha: null,
    dirty: false,
    startedAt: 1_750_000_000_000,
    finishedAt: 1_750_000_001_000,
    metricsJson: "[]",
    diagnosticsJson: "[]",
    syncedAt: 1_750_000_002_000,
  };
}

async function seededDb(): Promise<{ env: Env; db: Database }> {
  const binding = freshBinding();
  const db = drizzle(binding as never) as unknown as Database;
  await db.insert(cohorts).values({
    id: "cohort_1",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  await db.insert(users).values({ id: "user_1", name: "Ada", email: "ada@example.com" });
  await db.insert(teams).values({
    id: "team_1",
    cohortId: "cohort_1",
    name: "Analytical Engines",
    repoOwner: "demo-org",
    repoName: "team-repo",
    repoFullName: REPO,
    repoUrl: `https://github.com/${REPO}`,
    defaultBranch: "main",
  });
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_1", role: "admin" });
  return { env: { DB: binding } as unknown as Env, db };
}

test("a benchmark-scoped list excludes reports from a superseded version", async () => {
  const { env, db } = await seededDb();
  await db.insert(benchmarks).values([benchmarkRow(1, false), benchmarkRow(2, true)]);
  await db
    .insert(localReports)
    .values([reportRow("report_pre_bump", 1), reportRow("report_current", 2)]);

  const reports = await listTeamLocalReports(env, "user_1", BENCHMARK);
  assert.deepEqual(
    reports.map((report) => report.reportId),
    ["report_current"],
  );
  assert.equal(reports[0].benchmarkVersion, 2);
});

test("an unscoped list still returns every synced report", async () => {
  const { env, db } = await seededDb();
  await db.insert(benchmarks).values([benchmarkRow(1, false), benchmarkRow(2, true)]);
  await db
    .insert(localReports)
    .values([reportRow("report_pre_bump", 1), reportRow("report_current", 2)]);

  const reports = await listTeamLocalReports(env, "user_1");
  assert.equal(reports.length, 2);
});

test("a benchmark id with no active version returns nothing rather than stale rows", async () => {
  const { env, db } = await seededDb();
  await db.insert(benchmarks).values([benchmarkRow(1, false)]);
  await db.insert(localReports).values([reportRow("report_pre_bump", 1)]);

  assert.deepEqual(await listTeamLocalReports(env, "user_1", BENCHMARK), []);
});
