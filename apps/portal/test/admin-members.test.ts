import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createAuth } from "../worker/auth/better-auth.ts";
import type { Database } from "../worker/db/client.ts";
import { cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerAdminRoutes } from "../worker/routes/admin.ts";

/**
 * The admin console's member routes used to enforce less than the student
 * paths in routes/team-membership.ts: removal deleted the creator the team
 * page refuses to delete (B-01), re-adding an existing member upserted their
 * role back to "write" and silently demoted a creator (B-06), and neither the
 * cohort check nor the one-team rule was made before insert, so the unique
 * index surfaced as a raw 500 (B-07). These tests drive the real routes over
 * the real migrations, matching the harness in staff-roster.test.ts, because
 * every one of these is an authorization or refusal decision.
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

const OWNER = "AdaOwner";
const COHORT = "cohort_test";
const OTHER_COHORT = "cohort_other";

function harness() {
  const binding = freshBinding();
  const env = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
    PLATFORM_OWNER_LOGINS: OWNER,
  } as unknown as Env;
  const db = drizzle(binding as never) as unknown as Database;

  const app = new Hono<AppEnv>();
  registerAdminRoutes(app);
  app.onError(handleError);

  return {
    db,
    /** Signs a person in, sets their GitHub login and cohort, returns the session cookie. */
    async signIn(githubLogin: string, cohortId: string | null = COHORT): Promise<string> {
      const auth = createAuth(env);
      const result = await auth.api.signUpEmail({
        body: {
          email: `${githubLogin.toLowerCase()}@users.noreply.github.com`,
          password: "cogportal-local-dev-password",
          name: githubLogin,
        },
        returnHeaders: true,
      });
      await db
        .update(users)
        .set({ githubLogin, cohortId })
        .where(eq(users.id, result.response.user.id));
      return result.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    },
    async seedCohorts() {
      await db.insert(cohorts).values([
        { id: COHORT, slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true },
        { id: OTHER_COHORT, slug: "other", name: "Other cohort", joinCode: "OTHERCODE", active: false },
      ]);
    },
    async seedTeam(id: string, cohortId: string = COHORT) {
      await db.insert(teams).values({
        id,
        cohortId,
        name: id,
        description: null,
        repoOwner: "cogworks-test",
        repoName: id,
        repoFullName: `cogworks-test/${id}`,
        repoUrl: `https://github.com/cogworks-test/${id}`,
        defaultBranch: "main",
      });
    },
    async userId(githubLogin: string): Promise<string> {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.githubLogin, githubLogin))
        .limit(1);
      assert.ok(user, `no account for ${githubLogin}`);
      return user.id;
    },
    async roleOf(teamId: string, userId: string): Promise<string | undefined> {
      const [row] = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
        .limit(1);
      return row?.role;
    },
    async call(
      method: string,
      path: string,
      options: { cookie?: string; body?: unknown } = {},
    ): Promise<{ status: number; body: any }> {
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

test("admin removal of a team's creator is refused, not performed", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  const owner = await h.signIn(OWNER, null);
  await h.signIn("creator");
  const creatorId = await h.userId("creator");
  await h.db.insert(teamMembers).values({ teamId: "team_a", userId: creatorId, role: "admin" });

  const removed = await h.call("DELETE", "/admin/teams/team_a/members/creator", { cookie: owner });
  assert.equal(removed.status, 403);
  assert.equal(removed.body.error.code, "cannot_remove_creator");
  // Same truthful refusal as the team page's own path. The portal has no
  // creator-transfer or team-deletion operation, so the message must not
  // invent one; naming an unavailable way out is worse than naming none.
  assert.equal(removed.body.error.message, "The team creator cannot be removed.");
  assert.equal(await h.roleOf("team_a", creatorId), "admin");
});

test("admin removal of an ordinary member still works", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  const owner = await h.signIn(OWNER, null);
  await h.signIn("member");
  const memberId = await h.userId("member");
  await h.db.insert(teamMembers).values({ teamId: "team_a", userId: memberId, role: "write" });

  const removed = await h.call("DELETE", "/admin/teams/team_a/members/member", { cookie: owner });
  assert.equal(removed.status, 200);
  assert.equal(await h.roleOf("team_a", memberId), undefined);
});

test("re-adding a team's creator refuses and does not demote them", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  const owner = await h.signIn(OWNER, null);
  await h.signIn("creator");
  const creatorId = await h.userId("creator");
  await h.db.insert(teamMembers).values({ teamId: "team_a", userId: creatorId, role: "admin" });

  const readded = await h.call("POST", "/admin/teams/team_a/members", {
    cookie: owner,
    body: { login: "creator" },
  });
  // The admin is told the user was already a member instead of a summary
  // that looks like a successful add.
  assert.equal(readded.status, 409);
  assert.equal(readded.body.error.code, "already_on_team");
  assert.match(readded.body.error.message, /already on this team/);
  // The demotion was the bug: the old conflict branch set role back to "write".
  assert.equal(await h.roleOf("team_a", creatorId), "admin");
});

test("adding a user outside the team's cohort is refused", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  const owner = await h.signIn(OWNER, null);
  await h.signIn("outsider", OTHER_COHORT);

  const added = await h.call("POST", "/admin/teams/team_a/members", {
    cookie: owner,
    body: { login: "outsider" },
  });
  assert.equal(added.status, 403);
  assert.equal(added.body.error.code, "not_in_cohort");
  assert.match(added.body.error.message, /not in this team's cohort/);
  assert.equal(await h.roleOf("team_a", await h.userId("outsider")), undefined);
});

test("adding a user already on another team refuses with a sentence, not a 500", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  await h.seedTeam("team_b");
  const owner = await h.signIn(OWNER, null);
  await h.signIn("taken");
  const takenId = await h.userId("taken");
  await h.db.insert(teamMembers).values({ teamId: "team_b", userId: takenId, role: "write" });

  const added = await h.call("POST", "/admin/teams/team_a/members", {
    cookie: owner,
    body: { login: "taken" },
  });
  // The one-team rule used to survive only as the unique index, which
  // rendered as a generic 500.
  assert.equal(added.status, 409);
  assert.equal(added.body.error.code, "already_on_team");
  assert.match(added.body.error.message, /already on team team_b/);
  assert.equal(await h.roleOf("team_a", takenId), undefined);
  assert.equal(await h.roleOf("team_b", takenId), "write");
});

test("adding a new member from the cohort still works", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  const owner = await h.signIn(OWNER, null);
  await h.signIn("newcomer");

  const added = await h.call("POST", "/admin/teams/team_a/members", {
    cookie: owner,
    body: { login: "newcomer" },
  });
  assert.equal(added.status, 200);
  assert.equal(await h.roleOf("team_a", await h.userId("newcomer")), "write");
});
