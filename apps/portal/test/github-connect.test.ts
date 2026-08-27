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
import { createAuth } from "../worker/auth/better-auth.ts";
import type { Database } from "../worker/db/client.ts";
import { cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerGithubRoutes } from "../worker/routes/github.ts";

/**
 * Connecting a repository while already on a team used to run into the
 * one-team-per-user unique index and surface as a raw 500 after the team
 * row for the new repository had already been inserted, leaving an orphaned
 * claim with no members. The route must refuse before any insert, with the
 * same sentence the join path uses.
 *
 * The harness drives the real endpoint through the real session layer,
 * matching staff-roster.test.ts, because the property is a guard decision
 * on the authenticated session's team state.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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

interface Harness {
  env: Env;
  db: Database;
  /** Signs a person in, places them in the cohort, returns their cookie + id. */
  signIn(login: string): Promise<{ cookie: string; userId: string }>;
  call(
    method: string,
    path: string,
    options?: { cookie?: string; body?: unknown },
  ): Promise<{ status: number; body: any }>;
}

function harness(): Harness {
  const binding = freshBinding();
  const env = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
  } as unknown as Env;
  const db = drizzle(binding as never) as unknown as Database;

  const app = new Hono<AppEnv>();
  registerGithubRoutes(app);
  app.onError(handleError);

  return {
    env,
    db,
    async signIn(login) {
      const auth = createAuth(env);
      const result = await auth.api.signUpEmail({
        body: {
          email: `${login.toLowerCase()}@users.noreply.github.com`,
          password: "cogportal-local-dev-password",
          name: login,
        },
        returnHeaders: true,
      });
      const userId = result.response.user.id;
      await db
        .update(users)
        .set({ githubLogin: login, cohortId: "cohort_test" })
        .where(eq(users.id, userId));
      return {
        cookie: result.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
        userId,
      };
    },
    async call(method, path, options = {}) {
      const response = await app.fetch(
        new Request(`http://localhost:5173${path}`, {
          method,
          headers: {
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        }),
        env,
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

async function seedCohort(db: Database): Promise<void> {
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
}

test("a connect while already on a team is refused before any insert", async () => {
  const { db, signIn, call } = harness();
  await seedCohort(db);
  const { cookie, userId } = await signIn("Ada");
  await db.insert(teams).values({
    id: "team_existing",
    cohortId: "cohort_test",
    name: "First Team",
    repoOwner: "demo-org",
    repoName: "first-repo",
    repoFullName: "demo-org/first-repo",
    repoUrl: "https://github.com/demo-org/first-repo",
    defaultBranch: "main",
  });
  await db.insert(teamMembers).values({ teamId: "team_existing", userId, role: "admin" });

  const result = await call("POST", "/github/connect", {
    cookie,
    body: { fullName: FIXTURE_REPO.fullName, teamName: "Second Team" },
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "already_on_team");
  assert.equal(result.body.error.message, "You are already on a team.");
  // The refusal happened before the insert: no orphaned claim for the
  // requested repository.
  assert.deepEqual(
    await db.select().from(teams).where(eq(teams.repoFullName, FIXTURE_REPO.fullName)),
    [],
  );
});

test("a first connect still creates the team and membership", async () => {
  const { db, signIn, call } = harness();
  await seedCohort(db);
  const { cookie, userId } = await signIn("Grace");

  const result = await call("POST", "/github/connect", {
    cookie,
    body: { fullName: FIXTURE_REPO.fullName, teamName: "Fresh Team" },
  });

  assert.equal(result.status, 200);
  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  assert.ok(membership, "connect created a membership");
});
