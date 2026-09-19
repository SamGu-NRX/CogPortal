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
import { benchmarks, leaderboardSelections, officialAttempts, runMetrics, runs, cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerAdminRoutes } from "../worker/routes/admin.ts";
import { PRACTICE_LIMIT, OFFICIAL_LIMIT } from "@cogworks/contracts/schema";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "../src/routes/AdminPage.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

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
  // Same refusal as the team page's own path, and it names the real way out:
  // portal team authority mirrors GitHub repository permission, so the lever
  // is on GitHub, not in a portal operation the product does not have.
  assert.equal(
    removed.body.error.message,
    "A team admin cannot be removed here. Change their permission on GitHub instead.",
  );
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


test("admin totals span benchmarks and versions without per-version quota denominators", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_totals");
  const owner = await h.signIn(OWNER, null);
  const scopes = [
    { id: "test_audio", version: 1, title: "Audio identification" },
    { id: "test_vision", version: 1, title: "Old recognition" },
    { id: "test_vision", version: 2, title: "Face recognition" },
  ];
  for (const [index, scope] of scopes.entries()) {
    await h.db.insert(benchmarks).values({
      ...scope, contractVersion: "test-v1", entryPointName: scope.id,
      module: "vision", summary: "Test", active: true, primaryMetricKey: "accuracy",
    });
    const base = {
      teamId: "team_totals", benchmarkId: scope.id, benchmarkVersion: scope.version,
      contractVersion: "test-v1", status: "succeeded" as const, branch: "main",
      sha: "a".repeat(40), createdAt: 1,
    };
    for (let i = 0; i < PRACTICE_LIMIT; i++) {
      await h.db.insert(runs).values({ ...base, id: `practice_${index}_${i}`, mode: "practice" });
    }
    for (let i = 1; i <= OFFICIAL_LIMIT; i++) {
      const id = `official_${index}_${i}`;
      await h.db.insert(runs).values({ ...base, id, mode: "official", attemptNumber: i });
      await h.db.insert(officialAttempts).values({
        id: `attempt_${index}_${i}`, teamId: base.teamId, benchmarkId: scope.id,
        benchmarkVersion: scope.version, runId: id, attemptNumber: i, claimedAt: 1,
      });
    }
    const runId = `official_${index}_1`;
    await h.db.insert(runMetrics).values({
      runId, key: "accuracy", label: "Accuracy", value: 0.5 + index / 10,
      higherIsBetter: true, isPrimary: true, precision: 3,
    });
    await h.db.insert(leaderboardSelections).values({
      teamId: base.teamId, benchmarkId: scope.id, benchmarkVersion: scope.version,
      runId, selectedAt: index + 1,
    });
  }
  const result = await h.call("GET", "/admin/overview", { cookie: owner });
  assert.equal(result.status, 200);
  const overview = result.body;
  const team = overview.teams[0];
  assert.equal(team.practiceUsed, PRACTICE_LIMIT * scopes.length);
  assert.equal(team.officialUsed, OFFICIAL_LIMIT * scopes.length);
  assert.equal(team.published?.score, 0.7);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "overview"], { ...overview, scope: "ta" });
  const html = renderToStaticMarkup(React.createElement(
    QueryClientProvider, { client }, React.createElement(AdminPage),
  ));
  assert.match(html, /30 practice runs · 9 official attempts/);
  assert.doesNotMatch(html, /30\/10|9\/3/);
  client.clear();
  assert.equal(team.published?.benchmarkName, "Face recognition");
  assert.equal(team.published?.benchmarkVersion, 2);
});
