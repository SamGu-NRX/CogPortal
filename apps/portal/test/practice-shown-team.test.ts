import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { createAuth } from "../worker/auth/better-auth.ts";
import { benchmarks, cohorts, runs, runSurfaces, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerRunRoutes } from "../worker/routes/runs.ts";
import { runSurfaceHubs } from "./fixtures/run-surface-hub.ts";

/*
 * Starting a practice run names the team the Runs page showed. A window left
 * visible while another signed in as someone else, or a start request still
 * on the wire when its sender moved teams, otherwise started a run, and used a
 * practice run, on whichever team the cookie belonged to by then
 * (requireShownTeam in worker/auth/session.ts).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const BENCHMARK = "test-shown-team-benchmark";

function freshDb() {
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
        bind(...params: SQLInputValue[]) { bound = params; return prepared; },
        async run() { return { success: true, meta: statement.run(...bound) }; },
        execute() {
          const results = statement.all(...bound);
          const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
          return { success: true, results, meta: { changes } };
        },
        async all() { return { success: true, results: statement.all(...bound) }; },
        async raw() {
          statement.setReturnArrays(true);
          try { return statement.all(...bound); }
          finally { statement.setReturnArrays(false); }
        },
      };
      return prepared;
    },
    async batch(statements: Array<{ execute(): unknown }>) {
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
  return { sqlite, binding, db: drizzle(binding as never) };
}

async function harness(t: TestContext) {
  const { sqlite, binding, db } = freshDb();
  t.after(() => sqlite.close());
  const env = {
    DB: binding, ENVIRONMENT: "development", DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture", PUBLIC_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
  } as unknown as Env;
  const hubs = runSurfaceHubs(env);
  env.RUN_SURFACES = hubs.namespace;
  const routes = new Hono<AppEnv>();
  registerRunRoutes(routes);
  const app = new Hono<AppEnv>();
  app.route("/api", routes);
  app.onError(handleError);

  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true,
  });
  const signedIn = await createAuth(env).api.signUpEmail({
    body: { email: "ada@users.noreply.github.com", password: "cogportal-local-dev-password", name: "Ada" },
    returnHeaders: true,
  });
  const userId = signedIn.response.user.id;
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  await db.update(users).set({ githubLogin: "ada", cohortId: "cohort_test" }).where(eq(users.id, userId));
  for (const [id, name, channel] of [["team_a", "Team A", "channel_a"], ["team_b", "Difference Engines", "channel_b"]] as const) {
    await db.insert(teams).values({
      id, cohortId: "cohort_test", name,
      repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name,
      repoFullName: id === "team_a" ? FIXTURE_REPO.fullName : `synthetic/${id}`,
      repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch,
      repoId: id === "team_a" ? FIXTURE_REPO.repositoryId : null, discordChannelId: channel,
    });
  }
  await db.insert(teamMembers).values({ teamId: "team_a", userId, role: "write" });
  await db.insert(benchmarks).values({
    id: BENCHMARK, version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "submission",
    title: "Test benchmark", module: "vision", summary: "Synthetic shown-team test", active: true,
    primaryMetricKey: "accuracy", pluginVersion: "1", datasetVersion: "official-v1",
    scorerVersion: "1", runtimeVersion: "python-3.11", sandboxContract: 1,
  });
  const start = async (body: Record<string, unknown>) => {
    const response = await app.fetch(new Request("http://localhost:5173/api/runs/practice", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ benchmarkId: BENCHMARK, branch: "main", ...body }),
    }), env);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  /** Ada left team A and joined team B; her cookie now speaks for B. */
  const moveToB = async () => {
    await db.delete(teamMembers).where(eq(teamMembers.userId, userId));
    await db.insert(teamMembers).values({ teamId: "team_b", userId, role: "write" });
  };
  const rows = (table: string) => sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  return { db, hubs, start, moveToB, rows };
}

test("a start without the shown team is refused before any run or console exists", async (t) => {
  const h = await harness(t);
  const result = await h.start({});
  assert.deepEqual(result, { status: 409, body: { error: {
    code: "invalid_request", message: "This page is out of date. Reload it and try again.",
  } } });
  assert.deepEqual(h.rows("runs"), []);
  assert.deepEqual(h.rows("run_surfaces"), []);
  assert.deepEqual(h.hubs.requests, []);
});

test("a start from team A's page after its sender moved to team B starts nothing on either team", async (t) => {
  const h = await harness(t);
  await h.moveToB();
  const result = await h.start({ teamId: "team_a" });
  assert.deepEqual(result, { status: 409, body: { error: {
    code: "already_on_team", message: "You're on Difference Engines now, not the team this page showed. Reload to see it.",
  } } });
  // No run means no practice run used on B; quota is counted from these rows.
  assert.deepEqual(h.rows("runs"), []);
  assert.deepEqual(h.rows("run_surfaces"), []);
  assert.deepEqual(h.hubs.requests, []);
});

test("a start naming the caller's own team starts one run on it", async (t) => {
  const h = await harness(t);
  const result = await h.start({ teamId: "team_a" });
  assert.equal(result.status, 201);
  const started = await h.db.select().from(runs);
  assert.equal(started.length, 1);
  assert.equal(started[0].teamId, "team_a");
  assert.equal(started[0].id, result.body.runId);
  assert.equal((await h.db.select().from(runSurfaces)).length, 1);
});
