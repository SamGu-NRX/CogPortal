import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createAuth } from "../worker/auth/better-auth.ts";
import type { Database } from "../worker/db/client.ts";
import { accounts, cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerAdminRoutes } from "../worker/routes/admin.ts";

/**
 * The role a member's row stores is what the portal's own gates read --
 * publishing, official attempts, team settings. When someone else adds a
 * member, the row is written only after a GitHub read verified that
 * person's permission on the team's repository: adding someone here never
 * makes them a collaborator there. These tests drive the admin add over
 * the real routes and a stubbed GitHub API in a production-shaped
 * environment (GitHub configured, dev auth off), where every refusal
 * path is live.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const OWNER = "AdaOwner";
const COHORT = "cohort_test";
const REPO = "course-2026/team-repo";

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
          const rows = statement.all(...bound);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
  };
  // SAFETY: the shim implements the prepared-statement methods these routes use.
  return { db: drizzle(binding as never) as unknown as Database, binding };
}

/** Answers GitHub's collaborator-permission endpoint without touching the network. */
function stubGithub(t: TestContext, respond: () => { status: number; body?: unknown; headers?: HeadersInit }) {
  const previous = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/") && url.includes("/collaborators/") && url.endsWith("/permission")) {
      asked += 1;
      const answer = respond();
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: answer.headers,
      });
    }
    return previous(input as never);
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  return { asked: () => asked };
}

function harness() {
  const { db, binding } = freshDb();
  // Email/password sign-up is enabled exactly when devAuthAvailable, so the
  // people are created under a dev-auth env; the requests are then served
  // under the production-shaped env below, where every refusal path is live.
  const signupEnv = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "enabled",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
  } as unknown as Env;
  const env = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
    PLATFORM_OWNER_LOGINS: OWNER,
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  registerAdminRoutes(app);
  app.onError(handleError);
  let cookie = "";

  return {
    db,
    async seed() {
      await db.insert(cohorts).values({ id: COHORT, slug: "t", name: "Cohort", joinCode: "JOINCODE1", active: true });
      await db.insert(teams).values({
        id: "team_1",
        cohortId: COHORT,
        name: "Team",
        description: null,
        repoOwner: "course-2026",
        repoName: "team-repo",
        repoFullName: REPO,
        repoUrl: `https://github.com/${REPO}`,
        repoId: 424242,
        defaultBranch: "main",
      });
    },
    /** Signs the staff owner in and a student in, links the student's GitHub, and remembers the owner's cookie. */
    async signInPeople() {
      const auth = createAuth(signupEnv);
      const owner = await auth.api.signUpEmail({
        body: { email: "owner@example.test", password: "cogportal-local-dev-password", name: OWNER },
        returnHeaders: true,
      });
      const student = await auth.api.signUpEmail({
        body: { email: "grace@example.test", password: "cogportal-local-dev-password", name: "Grace" },
        returnHeaders: true,
      });
      await db.update(users).set({ githubLogin: OWNER }).where(eq(users.id, owner.response.user.id));
      await db
        .update(users)
        .set({ githubLogin: "grace", cohortId: COHORT })
        .where(eq(users.id, student.response.user.id));
      await db.insert(accounts).values({
        id: "account_grace",
        accountId: "gh-grace",
        providerId: "github",
        userId: student.response.user.id,
        accessToken: "token-grace",
      });
      cookie = owner.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      return student.response.user.id;
    },
    async add() {
      const response = await app.fetch(
        new Request("http://localhost:5173/admin/teams/team_1/members", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ login: "grace" }),
        }),
        env,
      );
      return { status: response.status, body: await response.json() };
    },
    async roleOf(userId: string) {
      const [row] = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, "team_1"), eq(teamMembers.userId, userId)))
        .limit(1);
      return row?.role;
    },
  };
}

test("the row stores the permission GitHub answered, here a plain write", async (t) => {
  const h = harness();
  await h.seed();
  const grace = await h.signInPeople();
  const github = stubGithub(t, () => ({ status: 200, body: { permission: "write" } }));

  const added = await h.add();
  assert.equal(added.status, 200);
  assert.equal(await h.roleOf(grace), "write");
  assert.equal(github.asked(), 1, "the add asked GitHub exactly once");
});

test("GitHub saying the person has no permission refuses the add and stores no row", async (t) => {
  const h = harness();
  await h.seed();
  const grace = await h.signInPeople();
  stubGithub(t, () => ({ status: 404 }));

  const refused = await h.add();
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "repo_access_required");
  assert.match(refused.body.error.message, /collaborator/i);
  assert.equal(await h.roleOf(grace), undefined, "no row is stored on a refusal");
});

test("an outage or a rate limit is a retryable refusal, not a no", async (t) => {
  const h = harness();
  await h.seed();
  const grace = await h.signInPeople();

  for (const answer of [
    { status: 500 },
    { status: 429, headers: { "retry-after": "30" } },
  ]) {
    const github = stubGithub(t, () => answer);
    const refused = await h.add();
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "github_unreachable");
    assert.equal(await h.roleOf(grace), undefined, "nothing is stored on an outage");
    github.asked();
  }
});
