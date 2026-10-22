import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  discordAccounts,
  leaderboardSelections,
  runMetrics,
  runSurfaces,
  runs,
  teamMembers,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { getLeaderboardReadModel } from "../worker/services/leaderboard.ts";

/**
 * The board /cog shows a student. These drive the real `PortalRpc` over the
 * real migrations; only `cloudflare:workers`, which exists only inside
 * workerd, is stubbed (as in rpc-refusals.test.ts).
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class WorkerEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}};export class DurableObject{};",
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { PortalRpc } = await import("../worker/rpc.ts");

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const GUILD = "111111111111111111";

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return {
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
}

/**
 * Two teams published on a benchmark that is not the default board, and the
 * student's team last worked on it. Picking a non-default benchmark is what
 * shows the board followed the team rather than landing there by chance.
 */
async function seeded() {
  // SAFETY: this SQLite adapter implements the D1 calls the leaderboard and RPC make.
  const env = { ENVIRONMENT: "development", COURSE_GUILD_ID: GUILD, DB: d1() } as unknown as Env;
  const db = getDb(env);
  const fallback = (await getLeaderboardReadModel(env)).benchmark;
  const active = await db.select().from(benchmarks).where(eq(benchmarks.active, true));
  const newest = new Map<string, (typeof active)[number]>();
  for (const row of active) {
    if ((newest.get(row.id)?.version ?? -1) < row.version) newest.set(row.id, row);
  }
  const target = [...newest.values()].find((row) => row.id !== fallback.id);
  assert.ok(target, "the migrations publish at least two active benchmarks");

  await db.insert(cohorts).values({ id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: false });
  const team = { cohortId: "cohort_test", description: null, repoOwner: "o", defaultBranch: "main" };
  await db.insert(teams).values([
    { ...team, id: "team_ada", name: "Analytical Engines", repoName: "r", repoFullName: "o/r", repoUrl: "https://github.com/o/r" },
    { ...team, id: "team_other", name: "Difference Engines", repoName: "s", repoFullName: "o/s", repoUrl: "https://github.com/o/s" },
  ]);
  await db.insert(users).values({ id: "user_ada", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort_test" });
  await db.insert(teamMembers).values({ teamId: "team_ada", userId: "user_ada", role: "write" });
  await db.insert(discordAccounts).values({ discordUserId: "discord_ada", userId: "user_ada", username: "ada", linkedAt: 1 });

  for (const [teamId, value] of [["team_ada", 0.7], ["team_other", 0.9]] as const) {
    const runId = `${teamId}_official`;
    await db.insert(runs).values({
      id: runId, teamId, benchmarkId: target.id, benchmarkVersion: target.version,
      contractVersion: target.contractVersion, mode: "official", status: "succeeded",
      branch: "main", sha: "a".repeat(40), createdAt: 10, finishedAt: 20, provider: "fixture",
      scorerVersion: target.scorerVersion,
    });
    await db.insert(runMetrics).values({
      runId, key: target.primaryMetricKey, label: target.primaryMetricKey, value,
      higherIsBetter: true, isPrimary: true, precision: 3,
    });
    await db.insert(leaderboardSelections).values({
      teamId, benchmarkId: target.id, benchmarkVersion: target.version, runId, selectedAt: 30,
    });
  }
  await db.insert(runSurfaces).values({
    id: "surface_ada", teamId: "team_ada", createdByUserId: "user_ada",
    benchmarkId: target.id, benchmarkVersion: target.version, createdAt: 40, updatedAt: 40,
  });
  await db.insert(runs).values({
    id: "team_ada_practice", teamId: "team_ada", benchmarkId: target.id, benchmarkVersion: target.version,
    contractVersion: target.contractVersion, mode: "practice", status: "succeeded", branch: "main",
    sha: "b".repeat(40), createdAt: 40, finishedAt: 50, provider: "fixture", scorerVersion: target.scorerVersion,
    surfaceId: "surface_ada",
  });
  return { rpc: new PortalRpc({} as never, env), db, target, fallback };
}

test("a linked student sees their team's benchmark with their own row marked", async () => {
  const { rpc, target } = await seeded();
  const board = await rpc.getLeaderboard(GUILD, undefined, "discord_ada");
  assert.equal(board.benchmark.id, target.id);
  assert.deepEqual(
    board.entries.map((entry) => [entry.rank, entry.teamName, entry.isYou]),
    [[1, "Difference Engines", false], [2, "Analytical Engines", true]],
  );
});

test("a benchmark the caller names wins over the team's latest one", async () => {
  const { rpc, fallback } = await seeded();
  const board = await rpc.getLeaderboard(GUILD, fallback.id, "discord_ada");
  assert.equal(board.benchmark.id, fallback.id);
});

test("the newest run on a retired benchmark falls back instead of choosing an older active run", async () => {
  const { rpc, db, target, fallback } = await seeded();
  const [retired] = await db.insert(benchmarks).values({
    ...target,
    id: "retired-for-discord-test",
    version: target.version + 100,
    active: false,
  }).returning();
  assert.ok(retired);
  await db.insert(runSurfaces).values({
    id: "surface_ada_new_retired", teamId: "team_ada", createdByUserId: "user_ada",
    benchmarkId: retired.id, benchmarkVersion: retired.version, createdAt: 200, updatedAt: 200,
  });
  await db.insert(runSurfaces).values({
    id: "surface_ada_old_active", teamId: "team_ada", createdByUserId: "user_ada",
    benchmarkId: target.id, benchmarkVersion: target.version, createdAt: 100, updatedAt: 300,
  });
  await db.insert(runs).values([
    {
      id: "team_ada_new_retired", teamId: "team_ada", benchmarkId: retired.id, benchmarkVersion: retired.version,
      contractVersion: retired.contractVersion, mode: "practice", status: "failed", branch: "main",
      sha: "c".repeat(40), createdAt: 200, finishedAt: 210, provider: "fixture", scorerVersion: retired.scorerVersion,
      surfaceId: "surface_ada_new_retired",
    },
    {
      id: "team_ada_old_active", teamId: "team_ada", benchmarkId: target.id, benchmarkVersion: target.version,
      contractVersion: target.contractVersion, mode: "practice", status: "succeeded", branch: "main",
      sha: "d".repeat(40), createdAt: 100, finishedAt: 110, provider: "fixture", scorerVersion: target.scorerVersion,
      surfaceId: "surface_ada_old_active",
    },
  ]);
  await db.update(benchmarks).set({ active: false }).where(eq(benchmarks.id, retired.id));
  const board = await rpc.getLeaderboard(GUILD, undefined, "discord_ada");
  assert.equal(board.benchmark.id, fallback.id);
});

test("a late event on an older run does not replace the newest run's board", async () => {
  const { rpc, db, target, fallback } = await seeded();
  await db.insert(runs).values({
    id: "team_ada_new_run", teamId: "team_ada", benchmarkId: target.id, benchmarkVersion: target.version,
    contractVersion: target.contractVersion, mode: "practice", status: "succeeded", branch: "main",
    sha: "e".repeat(40), createdAt: 200, finishedAt: 210, provider: "fixture", scorerVersion: target.scorerVersion,
  });
  await db.insert(runs).values({
    id: "team_ada_old_run", teamId: "team_ada", benchmarkId: fallback.id, benchmarkVersion: fallback.version,
    contractVersion: fallback.contractVersion, mode: "practice", status: "succeeded", branch: "main",
    sha: "f".repeat(40), createdAt: 100, finishedAt: 110, provider: "fixture", scorerVersion: fallback.scorerVersion,
  });
  await db.update(runSurfaces).set({ updatedAt: 9_999 }).where(eq(runSurfaces.id, "surface_ada"));
  const board = await rpc.getLeaderboard(GUILD, undefined, "discord_ada");
  assert.equal(board.benchmark.id, target.id);
});

test("a Discord account that is not linked still gets the public board, with no row marked", async () => {
  const { rpc, fallback } = await seeded();
  const board = await rpc.getLeaderboard(GUILD, undefined, "discord_stranger");
  assert.equal(board.benchmark.id, fallback.id);
  assert.ok(board.entries.every((entry) => !entry.isYou));
});
