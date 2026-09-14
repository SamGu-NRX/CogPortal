import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { StartLocalRunResponseSchema, type StartLocalRunRequest } from "@cogworks/contracts/schema";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cliDevices,
  cohorts,
  localRunSessions,
  teamMembers,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerLocalRunRoutes } from "../worker/routes/local-runs.ts";
import { buildRunSurfaceSnapshot } from "../worker/services/run-surfaces.ts";
import { sha256Hex } from "../worker/util/crypto.ts";
import { runSurfaceHubs } from "./fixtures/run-surface-hub.ts";

/**
 * Which repository a local session is recorded against. The route checked the
 * submitted name and then stored the SDK's null id, so a fresh run read as
 * predating the record and lost hosted verification.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const DEVICE_TOKEN = "cog_localrunstarttoken";
const BENCHMARK_ID = "vision-recognition";
const SESSION = `localrun_${"a".repeat(32)}`;
const SHA = "b".repeat(40);
const OTHER_REPO_ID = 999_999_999;

/** Lets a test hide the session lookup once, so the insert races a row that
 *  already exists and the conflict branch is the one under test. */
interface Race { hideSessionSelect: number; queries: string[] }

function freshDb(race: Race = { hideSessionSelect: 0, queries: [] }): { db: Database; binding: unknown; race: Race } {
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
      let bound: SQLInputValue[] = [];
      const prepared = {
        bind(...params: SQLInputValue[]) {
          bound = params;
          return prepared;
        },
        hidden() {
          if (race.hideSessionSelect <= 0) return false;
          if (!/^select\b[\s\S]*"local_run_sessions"/i.test(query)) return false;
          race.hideSessionSelect -= 1;
          return true;
        },
        async run() {
          race.queries.push(query);
          return { success: true, meta: statement.run(...bound) };
        },
        async all() {
          race.queries.push(query);
          if (prepared.hidden()) return { success: true, results: [] };
          return { success: true, results: statement.all(...bound) };
        },
        async raw() {
          race.queries.push(query);
          if (prepared.hidden()) return [];
          statement.setReturnArrays(true);
          const rows = statement.all(...bound);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
  };
  // SAFETY: this shim implements the prepared-statement methods used here;
  // Cloudflare's D1 type also requires host methods these tests never call.
  return { db: drizzle(binding as never), binding, race };
}

async function seed(db: Database, teamRepoId: number | null = FIXTURE_REPO.repositoryId): Promise<void> {
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values({ id: "user_1", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort_1" });
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Team", description: null,
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name, repoFullName: FIXTURE_REPO.fullName,
    repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch, repoId: teamRepoId,
  });
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_1", role: "admin" });
  await db.insert(benchmarks).values({
    id: BENCHMARK_ID, version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "submission",
    title: "Vision Recognition", module: "vision", summary: "fixture", active: true,
    primaryMetricKey: "accuracy", pluginVersion: "1", datasetVersion: "official-v1",
    scorerVersion: "1", runtimeVersion: "python-3.11", sandboxContract: 1,
  });
  await db.insert(cliDevices).values({
    id: "device_1", userId: "user_1", name: "laptop", tokenHash: await sha256Hex(DEVICE_TOKEN),
    createdAt: NOW, expiresAt: Date.now() + 86_400_000, lastUsedAt: null, revokedAt: null,
  });
}

function runtime(binding: unknown): Env {
  // SAFETY: these routes use the test D1 shim and hub assigned below, not ASSETS.
  const env = {
    DB: binding, ENVIRONMENT: "development", DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "fixture", PUBLIC_ORIGIN: "https://portal.example",
  } as Env;
  env.RUN_SURFACES = runSurfaceHubs(env).namespace;
  return env;
}

function app(): Hono<AppEnv> {
  const instance = new Hono<AppEnv>();
  registerLocalRunRoutes(instance);
  instance.onError(handleError);
  return instance;
}

function startBody(over: Partial<StartLocalRunRequest> = {}) {
  return {
    clientRunId: SESSION, benchmarkId: BENCHMARK_ID, benchmarkVersion: 1,
    repositoryId: null, repositoryFullName: FIXTURE_REPO.fullName,
    sha: SHA, branch: "main", dirty: false, ...over,
  };
}

function start(env: Env, over: Partial<StartLocalRunRequest> = {}): Promise<Response> {
  return app().fetch(new Request("http://localhost/v1/local-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_TOKEN}` },
    body: JSON.stringify(startBody(over)),
  }), env);
}

async function session(db: Database) {
  const [row] = await db.select().from(localRunSessions).where(eq(localRunSessions.id, SESSION));
  return row;
}

test("a start with no claimed id records the connection its name was checked against", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  assert.equal((await start(env)).status, 201, "a new session is created");
  assert.equal((await session(db)).repositoryId, FIXTURE_REPO.repositoryId);
});

test("the same start replays, and a matching claim is accepted too", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  const first = await start(env);
  assert.equal(first.status, 201);
  const body = StartLocalRunResponseSchema.parse(await first.json());

  // The installed SDK sends none on every attempt, including the retry.
  const replay = await start(env);
  assert.equal(replay.status, 200, "the replay branch was not taken");
  assert.equal(StartLocalRunResponseSchema.parse(await replay.json()).surfaceId, body.surfaceId);

  // A later SDK that does send the id agrees with the record.
  const claimed = await start(env, { repositoryId: FIXTURE_REPO.repositoryId });
  assert.equal(claimed.status, 200);
  assert.equal((await session(db)).repositoryId, FIXTURE_REPO.repositoryId);
});

for (const [name, teamRepoId] of [["a connected team", FIXTURE_REPO.repositoryId], ["a team with no recorded id", null]] as const) {
  test(`a claimed id the connection cannot corroborate is refused, for ${name}`, async () => {
    const { db, binding } = freshDb();
    await seed(db, teamRepoId);
    const env = runtime(binding);
    const response = await start(env, { repositoryId: OTHER_REPO_ID });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "forbidden");
    assert.equal(await session(db), undefined, "a refused start wrote a session");
  });
}

test("a team with no recorded id keeps recording none", async () => {
  const { db, binding } = freshDb();
  await seed(db, null);
  const env = runtime(binding);
  assert.equal((await start(env)).status, 201);
  assert.equal((await session(db)).repositoryId, null, "an id was invented for an unconnected team");
});

test("a session written before the id was recorded replays unchanged and is never enriched", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  assert.equal((await start(env)).status, 201);
  // Exactly what the old route stored: the name it checked, and no id.
  await db.update(localRunSessions).set({ repositoryId: null }).where(eq(localRunSessions.id, SESSION));
  const before = await session(db);

  const replay = await start(env);
  assert.equal(replay.status, 200, "the historical row did not replay");
  assert.deepEqual(await session(db), before, "the historical row was rewritten");
  assert.equal((await session(db)).repositoryId, null, "the historical row was enriched");

  // A claim against a row that never recorded one is still refused, as before.
  assert.equal((await start(env, { repositoryId: FIXTURE_REPO.repositoryId })).status, 409);
  assert.deepEqual(await session(db), before);
});

test("a reconnect under the same name rejects the session bound to the old one", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  assert.equal((await start(env)).status, 201);
  const before = await session(db);
  // Same owner/name, a different repository object behind it.
  await db.update(teams).set({ repoId: OTHER_REPO_ID }).where(eq(teams.id, "team_1"));
  assert.equal((await start(env)).status, 409);
  assert.deepEqual(await session(db), before, "a rejected replay still rewrote the row");
});

test("a changed connection name is still refused before anything else", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  const response = await start(env, { repositoryFullName: "someone-else/other-repo" });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: { message: string } }).error.message, /but your team is connected to/);
});

test("moving to another team cannot replay the first team's session", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  assert.equal((await start(env)).status, 201);
  const before = await session(db);

  // A second cohort, because one cohort cannot hold two teams on the same
  // repository (unique cohort_id, repo_full_name). Same name and same id, so
  // every other check passes and only the team differs.
  await db.insert(cohorts).values({ id: "cohort_2", slug: "c2", name: "Other cohort", joinCode: "JOINCODE2", active: true });
  await db.insert(teams).values({
    id: "team_2", cohortId: "cohort_2", name: "Other", description: null,
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name, repoFullName: FIXTURE_REPO.fullName,
    repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch, repoId: FIXTURE_REPO.repositoryId,
  });
  await db.delete(teamMembers).where(eq(teamMembers.userId, "user_1"));
  await db.insert(teamMembers).values({ teamId: "team_2", userId: "user_1", role: "admin" });

  assert.equal((await start(env)).status, 409, "another team's session replayed");
  assert.deepEqual(await session(db), before);
});

test("a successful local run offers hosted verification without becoming a hosted result", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const env = runtime(binding);
  assert.equal((await start(env)).status, 201);
  const surfaceId = `surface_${SESSION.slice(-20)}`;
  await db.update(localRunSessions)
    .set({ status: "succeeded", phase: "scoring", finishedAt: NOW + 1_000 })
    .where(eq(localRunSessions.id, SESSION));

  const snapshot = await buildRunSurfaceSnapshot(env, surfaceId);
  assert.equal(snapshot.stage, "local");
  assert.equal(snapshot.sourceRefusal, null);
  assert.equal(snapshot.actions.includes("verify_hosted"), true, "a fresh local run still cannot be verified");
  // Recording the repository authorises verification, not promotion: the local
  // score stays self-reported until the hosted run produces its own.
  assert.equal(snapshot.actions.includes("promote_official"), false);
  assert.equal(snapshot.actions.includes("publish_result"), false);

  // The contrast: a row with no recorded id keeps refusing, and says why.
  await db.update(localRunSessions).set({ repositoryId: null }).where(eq(localRunSessions.id, SESSION));
  const historical = await buildRunSurfaceSnapshot(env, surfaceId);
  assert.match(historical.sourceRefusal ?? "", /predates the repository/);
  assert.equal(historical.actions.includes("verify_hosted"), false);
});

/**
 * Two starts racing on one client run id. The first lookup is hidden so the
 * insert meets a row that already exists, which is the branch a real race
 * reaches and the plain replay above never does.
 */
for (const [name, over, expected] of [
  ["the recorded identity", {}, 201],
  ["a changed commit", { sha: "c".repeat(40) }, 409],
] as const) {
  test(`a concurrent start returns ${name}`, async () => {
    const race: Race = { hideSessionSelect: 0, queries: [] };
    const { db, binding } = freshDb(race);
    await seed(db);
    const env = runtime(binding);
    assert.equal((await start(env)).status, 201);
    const before = await session(db);
    assert.equal(before.repositoryId, FIXTURE_REPO.repositoryId);

    race.hideSessionSelect = 1;
    race.queries.length = 0;
    const response = await start(env, over);
    assert.equal(response.status, expected);

    // The zero-change branch, not the early replay: the insert ran and changed
    // nothing, so the route had to re-read the row it collided with.
    const inserts = race.queries.filter((q) => /^insert into "local_run_sessions"/i.test(q));
    assert.equal(inserts.length, 1, "the conflicting insert was never attempted");
    assert.match(inserts[0], /on conflict do nothing/i);
    assert.equal(race.hideSessionSelect, 0, "the first lookup was not the hidden one");

    // Either way the stored row is the one already recorded, unchanged.
    assert.deepEqual(await session(db), before);
    assert.equal((await db.select().from(localRunSessions)).length, 1);
  });
}
