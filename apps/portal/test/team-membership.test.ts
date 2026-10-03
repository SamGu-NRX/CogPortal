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
import { registerTeamMembershipRoutes } from "../worker/routes/team-membership.ts";

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

/** What these routes answer with: a team list, one team, or an error. */
type ApiResponse = {
  error?: { code: string; message: string };
} & Record<string, unknown> | Array<{ id: string } & Record<string, unknown>>;

interface Harness {
  env: Env;
  db: Database;
  /** Signs a person in, places them in the cohort, returns their cookie + id. */
  signIn(login: string): Promise<{ cookie: string; userId: string }>;
  call(
    method: string,
    path: string,
    options?: { cookie?: string; body?: unknown },
  ): Promise<{ status: number; body: ApiResponse }>;
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
  registerTeamMembershipRoutes(app);
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
      return { status: response.status, body: (await response.json()) as ApiResponse };
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

async function seededMembership() {
  const h = harness();
  await seedCohort(h.db);
  const person = await h.signIn("Ada");
  for (const provenance of ["live", "archive"] as const) {
    await h.db.insert(teams).values({
      id: `team_${provenance}`,
      cohortId: "cohort_test",
      name: `${provenance} team`,
      provenance,
      repoOwner: FIXTURE_REPO.owner,
      repoName: FIXTURE_REPO.name,
      repoFullName: provenance === "live" ? FIXTURE_REPO.fullName : "archive/past-team",
      repoUrl: FIXTURE_REPO.url,
      defaultBranch: "main",
    });
  }
  return { ...h, ...person };
}

test("the cohort join list includes live teams and excludes archive teams", async () => {
  const { call, cookie } = await seededMembership();
  const result = await call("GET", "/cohorts/teams", { cookie });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body));
  assert.deepEqual(result.body.map((team) => team.id), ["team_live"]);
});

test("a direct archive join is forbidden before repository access or membership insertion", async () => {
  const { call, cookie, db } = await seededMembership();
  const result = await call("POST", "/team/join", { cookie, body: { teamId: "team_archive" } });
  assert.equal(result.status, 403);
  assert.ok(!Array.isArray(result.body));
  assert.equal(result.body.error?.code, "forbidden");
  assert.equal(result.body.error?.message,
    "This is a past-course demonstration with names replaced, so there's nothing to join. Choose a current team.");
  // This account has no GitHub token; reaching permission work would return repo_access_required.
  assert.deepEqual(await db.select().from(teamMembers), []);
});

test("a live fixture team still accepts a join", async () => {
  const { call, cookie, userId, db } = await seededMembership();
  const result = await call("POST", "/team/join", { cookie, body: { teamId: "team_live" } });
  assert.equal(result.status, 200);
  const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId));
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].teamId, "team_live");
  assert.equal(memberships[0].role, "write");
});
