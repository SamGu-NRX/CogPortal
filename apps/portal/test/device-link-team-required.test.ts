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
import { cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerConnectionRoutes } from "../worker/routes/connections.ts";

/*
 * A student with no team who runs `cogworks link` and opens the URL is sent
 * to /join, and approving the code is refused for want of a team. The code
 * survives that refusal, so the terminal is told why it is still waiting
 * (`teamRequired` on the poll) instead of polling in silence until expiry.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
        async all() { return { success: true, results: statement.all(...bound) }; },
        async raw() {
          statement.setReturnArrays(true);
          try { return statement.all(...bound); }
          finally { statement.setReturnArrays(false); }
        },
      };
      return prepared;
    },
  };
  return { sqlite, db: drizzle(binding as never), binding };
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
  const routes = new Hono<AppEnv>();
  registerConnectionRoutes(routes);
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

  const post = async (path: string, body: Record<string, unknown>, withCookie = false) => {
    const response = await app.fetch(new Request(`http://localhost:5173/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(withCookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const joinTeam = async () => {
    await db.insert(teams).values({
      id: "team_a", cohortId: "cohort_test", name: "Team A",
      repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name, repoFullName: FIXTURE_REPO.fullName,
      repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch,
      repoId: FIXTURE_REPO.repositoryId, discordChannelId: "channel_a",
    });
    await db.insert(teamMembers).values({ teamId: "team_a", userId, role: "write" });
  };
  return { post, joinTeam };
}

test("an approval refused for no team is reported to the polling CLI and the code still links", async (t) => {
  const h = await harness(t);
  const start = await h.post("/v1/cli/device/start", {});
  assert.equal(start.status, 200);
  const deviceCode = start.body.deviceCode as string;
  const userCode = start.body.userCode as string;
  const poll = () => h.post("/v1/cli/device/token", { deviceCode });

  assert.deepEqual(await poll(), {
    status: 200, body: { status: "pending", retryAfterSeconds: 5, teamRequired: false },
  });

  const refused = await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  assert.deepEqual(refused, {
    status: 403, body: { error: { code: "no_team", message: "Connect a repository to continue." } },
  });

  assert.deepEqual(await poll(), {
    status: 200, body: { status: "pending", retryAfterSeconds: 5, teamRequired: true },
  });

  await h.joinTeam();
  const approved = await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  assert.deepEqual(approved, { status: 200, body: { ok: true } });
  const linked = await poll();
  assert.equal(linked.status, 200);
  assert.equal(linked.body.status, "authorized");
});
