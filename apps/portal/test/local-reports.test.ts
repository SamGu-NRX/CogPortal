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
import {
  getLatestTeamWeights,
  getWeightUploadTarget,
  listTeamLocalReports,
  getLocalReport,
  upsertLocalReport,
} from "../worker/services/local-reports.ts";
import { LocalReportInputSchema, LocalReportWeightsSchema } from "@cogworks/contracts/schema";
import { weightManifest } from "../worker/services/weights.ts";

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


test("a report cannot upload weights into another repository prefix", async () => {
  const { env, db } = await seededDb();
  await db.insert(localReports).values({
    ...reportRow("report_other_repo", 1),
    repositoryFullName: "other-org/other-repo",
    sha: "a".repeat(40),
    weightsUsedJson: JSON.stringify(["models/search.pkl"]),
  });

  await assert.rejects(
    getWeightUploadTarget(env, "user_1", "report_other_repo", "models/search.pkl"),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 403 &&
      /team repository/.test(error.message),
  );
});

test("the newest matching team report supplies the run weight paths", async () => {
  const { env, db } = await seededDb();
  await db.insert(users).values([
    { id: "user_2", name: "Grace", email: "grace@example.com" },
    { id: "user_3", name: "Mallory", email: "mallory@example.com" },
  ]);
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_2", role: "member" });
  const sha = "b".repeat(40);
  await db.insert(localReports).values([
    {
      ...reportRow("report_old_member", 1),
      sha,
      weightsUsedJson: JSON.stringify(["models/old.pkl"]),
      syncedAt: 10,
    },
    {
      ...reportRow("report_new_member", 1),
      userId: "user_2",
      sha,
      weightsUsedJson: JSON.stringify(["models/current.pkl"]),
      syncedAt: 20,
    },
    {
      ...reportRow("report_newest_outsider", 1),
      userId: "user_3",
      sha,
      weightsUsedJson: JSON.stringify(["models/injected.pkl"]),
      syncedAt: 30,
    },
    {
      ...reportRow("report_wrong_commit", 1),
      sha: "c".repeat(40),
      weightsUsedJson: JSON.stringify(["models/wrong-commit.pkl"]),
      syncedAt: 40,
    },
  ]);

  assert.deepEqual(await getLatestTeamWeights(env, "team_1", REPO, sha), {
    weightsUsed: ["models/current.pkl"],
    weightsUploaded: null,
  });
});

test("legacy reports remain readable and upsertable without declaring committed weights", async () => {
  const { env, db } = await seededDb();
  const sha = "a".repeat(40);
  await db.insert(localReports).values({
    ...reportRow("report_legacy", 1), sha, weightsUsedJson: '["model.pkl"]',
  });
  const report = await getLocalReport(env, "report_legacy");
  assert.ok(report);
  assert.equal(report.weightsUploaded, null);
  const { weightsUploaded: _unknown, ...legacy } = report;
  const saved = await upsertLocalReport(env, "user_1", legacy);
  assert.equal(saved.created, false);
  assert.equal(saved.report.weightsUploaded, null);
  const weights = await getLatestTeamWeights(env, "team_1", REPO, sha);
  await assert.rejects(
    weightManifest({ head: async () => null }, REPO, sha, weights.weightsUsed, weights.weightsUploaded),
    /doesn't identify its uploaded weights/,
  );
  assert.deepEqual(await getWeightUploadTarget(env, "user_1", report.reportId, "model.pkl"), {
    repositoryFullName: REPO, sha,
  });
});

test("report upload requirements survive upsert and dispatch selection", async () => {
  const { env, db } = await seededDb();
  const sha = "a".repeat(40);
  await db.insert(localReports).values({
    ...reportRow("report_upload", 1), sha, weightsUsedJson: '["model.pkl", "committed.pkl"]',
  });
  const report = await getLocalReport(env, "report_upload");
  assert.ok(report);
  const saved = await upsertLocalReport(env, "user_1", { ...report, weightsUploaded: [{ path: "model.pkl", sha256: "a".repeat(64) }] });
  assert.deepEqual(saved.report.weightsUploaded, [{ path: "model.pkl", sha256: "a".repeat(64) }]);
  const weights = await getLatestTeamWeights(env, "team_1", REPO, sha);
  assert.deepEqual(weights, {
    weightsUsed: ["model.pkl", "committed.pkl"], weightsUploaded: [{ path: "model.pkl", sha256: "a".repeat(64) }],
  });
  const stored: R2Object = {
    key: "model.pkl", version: "1", size: 3, etag: "etag", httpEtag: '"etag"',
    uploaded: new Date(),
    checksums: { sha256: new Uint8Array(32).fill(0xbb).buffer, toJSON: () => ({}) },
    storageClass: "Standard", writeHttpMetadata: () => {},
  };
  const bucket = { head: async () => stored };
  await assert.rejects(
    weightManifest(bucket, REPO, sha, weights.weightsUsed, weights.weightsUploaded),
    /does not match this report; sync the report again/,
  );
  stored.checksums.sha256 = new Uint8Array(32).fill(0xaa).buffer;
  assert.deepEqual(
    await weightManifest(bucket, REPO, sha, weights.weightsUsed, weights.weightsUploaded),
    [{ path: "model.pkl", sha256: "a".repeat(64), size: 3 }],
  );
  await assert.rejects(
    upsertLocalReport(env, "user_1", { ...report, weightsUploaded: [{ path: "other.pkl", sha256: "a".repeat(64) }] }),
    /weightsUploaded must name paths from weightsUsed with SHA-256 digests/,
  );
  const committed = await upsertLocalReport(env, "user_1", { ...report, weightsUploaded: [] });
  assert.deepEqual(committed.report.weightsUploaded, []);
  // Old CLIs still authorize uploads through weightsUsed.
  await getWeightUploadTarget(env, "user_1", report.reportId, "model.pkl");
});

test("malformed provenance is rejected at the report boundary", () => {
  for (const weightsUploaded of ["model.pkl", [1], ["other.pkl"], {},
    [{ path: "model.pkl" }], [{ path: "model.pkl", sha256: "invalid" }],
    [{ path: "other.pkl", sha256: "a".repeat(64) }]]) {
    assert.equal(LocalReportWeightsSchema.safeParse({
      weightsUsed: ["model.pkl"], weightsUploaded,
    }).success, false);
  }
  assert.equal(LocalReportInputSchema.shape.weightsUploaded.safeParse([1]).success, false);
});
