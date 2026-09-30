import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
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

// Which repository a synced local run is recorded against. The CLI only reads
// the origin remote, so it cannot name GitHub's numeric id; the route records
// the connected repository it checked the checkout's name against. Before it
// did, every synced run read as predating the record and never earned hosted
// verification.

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const DEVICE_TOKEN = "cog_localrunstarttoken";
const BENCHMARK_ID = "vision-recognition";
const SESSION = `localrun_${"a".repeat(32)}`;
const SURFACE_ID = `surface_${SESSION.slice(-20)}`;
const OTHER_REPO_ID = FIXTURE_REPO.repositoryId + 1;

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
        run() {
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
    },
  };
  return { db: drizzle(binding as never), binding };
}

async function seed(db: Database): Promise<void> {
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values({ id: "user_1", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort_1" });
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Team", description: null,
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name, repoFullName: FIXTURE_REPO.fullName,
    repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch, repoId: FIXTURE_REPO.repositoryId,
  });
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_1", role: "admin" });
  await db.insert(benchmarks).values({
    id: BENCHMARK_ID, version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "submission",
    title: "Vision Recognition", module: "vision", summary: "fixture", active: true,
    primaryMetricKey: "accuracy", pluginVersion: "1", datasetVersion: "official-v1",
    scorerVersion: "1", runtimeVersion: "python-3.11",
  });
  await db.insert(cliDevices).values({
    id: "device_1", userId: "user_1", name: "laptop", tokenHash: await sha256Hex(DEVICE_TOKEN),
    // requireDevice compares expiry against the real clock, not the fixture's.
    createdAt: NOW, expiresAt: Date.now() + 86_400_000, lastUsedAt: null, revokedAt: null,
  });
}

function env(binding: unknown): Env {
  // SAFETY: these routes use the test D1 shim and the hub fixture, not ASSETS.
  const runtime = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "fixture",
    PUBLIC_ORIGIN: "https://portal.example",
  } as Env;
  // Snapshots round-trip through the hub, so the real one stands in here.
  runtime.RUN_SURFACES = runSurfaceHubs(runtime).namespace;
  return runtime;
}

function start(binding: unknown, repositoryFullName = FIXTURE_REPO.fullName): Promise<Response> {
  const app = new Hono<AppEnv>();
  registerLocalRunRoutes(app);
  app.onError(handleError);
  return app.fetch(
    new Request("http://localhost/v1/local-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_TOKEN}` },
      body: JSON.stringify({
        clientRunId: SESSION, benchmarkId: BENCHMARK_ID, benchmarkVersion: 1,
        repositoryFullName, sha: "b".repeat(40), branch: "main", dirty: false,
      }),
    }),
    env(binding),
  );
}

/** What the CLI leaves behind after `cogworks sync` finishes: a session that
 *  started through the route and then completed. */
async function syncedSession(db: Database, binding: unknown) {
  assert.equal((await start(binding)).status, 201);
  await db
    .update(localRunSessions)
    .set({ status: "succeeded", phase: "scoring", finishedAt: NOW + 1_000 })
    .where(eq(localRunSessions.id, SESSION));
  const [row] = await db.select().from(localRunSessions).where(eq(localRunSessions.id, SESSION));
  assert.ok(row);
  return row;
}

test("a synced local run from the connected repository earns hosted verification", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  const row = await syncedSession(db, binding);
  assert.equal(row.repositoryId, FIXTURE_REPO.repositoryId, "the session did not record the connected repository");

  const snapshot = await buildRunSurfaceSnapshot(env(binding), SURFACE_ID);
  assert.equal(snapshot.stage, "local");
  assert.equal(snapshot.sourceRefusal, null);
  assert.ok(snapshot.actions.includes("verify_hosted"), "a fresh local run could not be verified");
});

test("a synced local run from another repository does not", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // A checkout that names another repository never becomes a session.
  const refused = await start(binding, "someone-else/other-repo");
  assert.equal(refused.status, 409);
  assert.equal((await db.select().from(localRunSessions)).length, 0, "a refused start wrote a session");

  // A session synced from the connected repository stops being verifiable
  // once the team connects somewhere else, because it recorded which
  // repository it was about.
  await syncedSession(db, binding);
  await db
    .update(teams)
    .set({ repoId: OTHER_REPO_ID, repoFullName: "someone-else/other-repo" })
    .where(eq(teams.id, "team_1"));
  const snapshot = await buildRunSurfaceSnapshot(env(binding), SURFACE_ID);
  assert.match(snapshot.sourceRefusal ?? "", /no longer connected/);
  assert.ok(!snapshot.actions.includes("verify_hosted"), "a run from a repository the team left was still verifiable");
});
