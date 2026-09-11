import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { getDb, type Database } from "../worker/db/client.ts";
import { benchmarks, leaderboardSelections, runMetrics, runs, teams } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { ApiHttpError } from "../worker/http/errors.ts";
import { getFamilyLeaderboardReadModel, getLeaderboardReadModel } from "../worker/services/leaderboard.ts";
import { publishOfficialRun, type RunActor } from "../worker/services/run-actions.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const UPGRADE = "0039_week2_recognition_v2.sql";
const RECOGNITION = "vision-recognition";
const CLUSTERING = "vision-clustering";

function freshDb(beforeUpgrade = false) {
  const sqlite = new DatabaseSync(":memory:");
  const migrate = (file: string) => sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
  const upgradeAt = files.indexOf(UPGRADE);
  assert.ok(upgradeAt >= 0, `${UPGRADE} is missing`);
  for (const file of beforeUpgrade ? files.slice(0, upgradeAt) : files) migrate(file);
  const binding = {
    prepare(query: string) {
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
        async all() {
          return { success: true, results: statement.all(...bound) };
        },
        async raw() {
          statement.setReturnArrays(true);
          try {
            return statement.all(...bound);
          } finally {
            statement.setReturnArrays(false);
          }
        },
      };
      return prepared;
    },
  };
  // SAFETY: this SQLite adapter implements the D1 calls used here; fixture publication needs no other bindings.
  const env = { DB: binding as unknown as Env["DB"] } as Env;
  return {
    db: getDb(env), env,
    upgrade: () => files.slice(upgradeAt).forEach(migrate),
    close: () => sqlite.close(),
  };
}

async function actorFor(db: Database, teamId = "team_demo"): Promise<RunActor> {
  // The migrated demo team has a renamed repository; use the explicit fixture
  // repository so publication checks do not need GitHub credentials.
  await db.update(teams).set({
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name,
    repoFullName: FIXTURE_REPO.fullName, repoUrl: FIXTURE_REPO.url,
    repoId: FIXTURE_REPO.repositoryId,
  }).where(eq(teams.id, teamId));
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  assert.ok(team);
  return { userId: "user_test", githubLogin: "ada", team, role: "write" };
}

type RunOverrides = Partial<Pick<typeof runs.$inferInsert,
  "teamId" | "mode" | "status" | "sha" | "repositoryId" | "scorerVersion">>;

async function addRun(db: Database, id: string, benchmarkId = RECOGNITION, overrides: RunOverrides = {}) {
  const [benchmark] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.version, 2)));
  assert.ok(benchmark);
  await db.insert(runs).values({
    id, teamId: "team_demo", benchmarkId, benchmarkVersion: 2,
    contractVersion: benchmark.contractVersion, mode: "official", status: "succeeded",
    branch: "main", sha: "a".repeat(40), repositoryId: 123,
    createdAt: 10, finishedAt: 20, provider: "modal",
    scorerVersion: benchmark.scorerVersion, ...overrides,
  });
  const metrics = benchmarkId === RECOGNITION
    ? [["recognition_score", 0.75], ["known_identification", 0.6], ["unknown_lifecycle", 0.9]] as const
    : [["clustering_pairwise_f1", 0.3]] as const;
  for (const [key, value] of metrics) {
    await db.insert(runMetrics).values({
      runId: id, key, label: key, value, higherIsBetter: true,
      isPrimary: key === benchmark.primaryMetricKey, precision: 4,
    });
  }
  return id;
}

async function selectRun(db: Database, runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  assert.ok(run);
  await db.insert(leaderboardSelections).values({
    teamId: run.teamId, benchmarkId: run.benchmarkId, benchmarkVersion: run.benchmarkVersion,
    runId, selectedAt: 30,
  });
}

function rejectsWith(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiHttpError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}

test("recognition migration hides old selections on both boards without rewriting history", async (t) => {
  const h = freshDb(true);
  t.after(h.close);
  for (const teamId of ["team_demo", "team_eigenfaces"]) {
    await selectRun(h.db, await addRun(h.db, `${teamId}_recognition`, RECOGNITION, { teamId }));
    await selectRun(h.db, await addRun(h.db, `${teamId}_clustering`, CLUSTERING, { teamId }));
  }
  assert.equal((await getLeaderboardReadModel(h.env, RECOGNITION)).entries.length, 2);
  assert.equal((await getFamilyLeaderboardReadModel(h.env)).entries.length, 2);
  const historicalRuns = await h.db.select().from(runs);
  const historicalSelections = await h.db.select().from(leaderboardSelections);

  h.upgrade();
  assert.deepEqual((await getLeaderboardReadModel(h.env, RECOGNITION)).entries, []);
  assert.deepEqual((await getFamilyLeaderboardReadModel(h.env)).entries, []);
  assert.deepEqual(await h.db.select().from(runs), historicalRuns);
  assert.deepEqual(await h.db.select().from(leaderboardSelections), historicalSelections);

  const actor = await actorFor(h.db);
  const current = await addRun(h.db, "current_recognition");
  assert.deepEqual(await publishOfficialRun(h.env, actor, current), { ok: true, surfaceId: null });
  const track = await getLeaderboardReadModel(h.env, RECOGNITION, actor.team.id);
  const family = await getFamilyLeaderboardReadModel(h.env, "vision-overall", actor.team.id);
  assert.deepEqual(track.entries.map((entry) => [entry.teamName, entry.rank, entry.isYou]),
    [[actor.team.name, 1, true]]);
  assert.equal(track.entries[0].primaryMetric.value, 0.75);
  assert.deepEqual(family.entries.map((entry) => [entry.teamName, entry.rank, entry.isYou]),
    [[actor.team.name, 1, true]]);
  assert.ok(Math.abs(family.entries[0].primaryMetric.value - 0.6) < 1e-12);
  assert.equal((await h.db.select().from(runs)).length, historicalRuns.length + 1);
  assert.equal((await h.db.select().from(leaderboardSelections)).length, historicalSelections.length);
});

test("publication uses the catalog at publication time and preserves the existing selection on rejection", async (t) => {
  const h = freshDb(true);
  t.after(h.close);
  const actor = await actorFor(h.db);
  const stale = await addRun(h.db, "created_before_upgrade");
  await selectRun(h.db, stale);
  h.upgrade();
  const before = await h.db.select().from(leaderboardSelections);
  await assert.rejects(publishOfficialRun(h.env, actor, stale), rejectsWith(409, "not_selectable"));
  assert.deepEqual(await h.db.select().from(leaderboardSelections), before);

  const current = await addRun(h.db, "created_after_upgrade");
  await publishOfficialRun(h.env, actor, current);
  const selected = await h.db.select().from(leaderboardSelections);
  assert.ok(selected.some((row) => row.runId === current));
  await assert.rejects(publishOfficialRun(h.env, actor, stale), rejectsWith(409, "not_selectable"));
  assert.deepEqual(await h.db.select().from(leaderboardSelections), selected);
  const [oldRun] = await h.db.select().from(runs).where(eq(runs.id, stale));
  assert.equal(oldRun.scorerVersion, "recognition-v1");
});

for (const [name, overrides, status, code] of [
  ["another team's run", { teamId: "team_eigenfaces" }, 404, "not_found"],
  ["practice run", { mode: "practice" }, 409, "not_selectable"],
  ["failed official run", { status: "failed" }, 409, "not_selectable"],
] as const) {
  test(`current scorer does not make ${name} publishable`, async (t) => {
    const h = freshDb();
    t.after(h.close);
    const actor = await actorFor(h.db);
    await selectRun(h.db, await addRun(h.db, "existing"));
    const before = await h.db.select().from(leaderboardSelections);
    const candidate = await addRun(h.db, "candidate", RECOGNITION, overrides);
    await assert.rejects(publishOfficialRun(h.env, actor, candidate), rejectsWith(status, code));
    assert.deepEqual(await h.db.select().from(leaderboardSelections), before);
  });
}

for (const [name, overrides] of [
  ["different commit", { sha: "b".repeat(40) }],
  ["different repository", { repositoryId: 456 }],
  ["unknown repository", { repositoryId: null }],
  ["stale clustering scorer", { scorerVersion: "clustering-v1" }],
] as const) {
  test(`family still excludes selections with ${name}`, async (t) => {
    const h = freshDb();
    t.after(h.close);
    await selectRun(h.db, await addRun(h.db, "recognition"));
    await selectRun(h.db, await addRun(h.db, "clustering", CLUSTERING, overrides));
    assert.equal((await getLeaderboardReadModel(h.env, RECOGNITION)).entries.length, 1);
    assert.equal((await getLeaderboardReadModel(h.env, CLUSTERING)).entries.length,
      name === "stale clustering scorer" ? 0 : 1);
    assert.deepEqual((await getFamilyLeaderboardReadModel(h.env)).entries, []);
    if (name === "stale clustering scorer") {
      await assert.rejects(publishOfficialRun(h.env, await actorFor(h.db), "clustering"),
        rejectsWith(409, "not_selectable"));
    }
  });
}

test("current recognition alone does not complete the family", async (t) => {
  const h = freshDb();
  t.after(h.close);
  await selectRun(h.db, await addRun(h.db, "recognition"));
  assert.equal((await getLeaderboardReadModel(h.env, RECOGNITION)).entries.length, 1);
  assert.deepEqual((await getFamilyLeaderboardReadModel(h.env)).entries, []);
});
