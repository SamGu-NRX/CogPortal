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
import { benchmarks, leaderboardSelections, officialAttempts, platformStaff, runMetrics, runs, cohorts, teamMembers, teamTas, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerAdminRoutes } from "../worker/routes/admin.ts";
import { registerCohortRoutes } from "../worker/routes/cohorts.ts";
import {
  AdminOverviewSchema,
  PRACTICE_LIMIT,
  OFFICIAL_LIMIT,
  type AdminOverview,
} from "@cogworks/contracts/schema";
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

function freshBinding() {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  let statementCount = 0;

  function prepare(query: string) {
    statementCount++;
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
  return { prepare, statements: () => statementCount };
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
  registerCohortRoutes(app);
  app.onError(handleError);

  return {
    db,
    /** Statements prepared against the binding so far, which is one D1 query each. */
    statements: binding.statements,
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

test("a right code for a closed cohort says enrollment is closed, a wrong one does not", async () => {
  const h = harness();
  await h.seedCohorts();
  const student = await h.signIn("student", null);

  const closed = await h.call("POST", "/cohorts/join", { cookie: student, body: { code: "othercode" } });
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error.message, "That code is right, but enrollment is closed. Ask your instructor to open it.");

  const wrong = await h.call("POST", "/cohorts/join", { cookie: student, body: { code: "NOTACODE" } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, "cohort_code_invalid");
  const [row] = await h.db.select({ cohortId: users.cohortId }).from(users).where(eq(users.githubLogin, "student"));
  assert.equal(row?.cohortId, null);
});

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
  // Same refusal as the team page's own path. It must not send staff to
  // GitHub: the stored role is only re-read when the admin opens team
  // settings, and a creator who owns the fork cannot be demoted there at all.
  // Nor may it promise the admin can manage the team: a creator with write
  // access is stored as admin but refused settings (routes/team.ts).
  assert.equal(removed.body.error.message, "A team admin can't be removed.");
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

test("the overview calls a selection published only when its board would rank it", async () => {
  // The newest selection is a partial result with no "overall", flagged
  // primary on text MRR. Its board leaves it out, so the console must too.
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_partial");
  const owner = await h.signIn(OWNER, null);
  const scopes = [
    { id: "test_audio", title: "Audio identification", key: "overall", value: 0.4, selectedAt: 1 },
    { id: "test_language", title: "Semantic search", key: "text_mrr", value: 0.95, selectedAt: 2 },
  ];
  for (const scope of scopes) {
    await h.db.insert(benchmarks).values({
      id: scope.id, version: 1, title: scope.title, contractVersion: "test-v1", entryPointName: scope.id,
      module: "language", summary: "Test", active: true, primaryMetricKey: "overall",
    });
    const runId = `${scope.id}_official`;
    await h.db.insert(runs).values({
      id: runId, teamId: "team_partial", benchmarkId: scope.id, benchmarkVersion: 1, contractVersion: "test-v1",
      mode: "official", status: "succeeded", branch: "main", sha: "a".repeat(40), createdAt: 1,
    });
    await h.db.insert(runMetrics).values({
      runId, key: scope.key, label: scope.key, value: scope.value, higherIsBetter: true, isPrimary: true, precision: 3,
    });
    await h.db.insert(leaderboardSelections).values({
      teamId: "team_partial", benchmarkId: scope.id, benchmarkVersion: 1, runId, selectedAt: scope.selectedAt,
    });
  }
  const published = async () => {
    const result = await h.call("GET", "/admin/overview", { cookie: owner });
    assert.equal(result.status, 200);
    return result.body.teams[0].published;
  };
  assert.deepEqual(await published(), { score: 0.4, benchmarkName: "Audio identification", benchmarkVersion: 1 });
  await h.db.delete(leaderboardSelections).where(eq(leaderboardSelections.benchmarkId, "test_audio"));
  assert.equal(await published(), null);
});

test("the overview reads every team at once and keeps each team's figures on its own row", async () => {
  // It used to spend six D1 queries per team, and D1's free plan documents a
  // limit of 50 per invocation, which that passes at about eight live teams.
  // Reading all teams per statement fixes that, and the way that goes wrong
  // is one team's members or score landing on another team's row.
  const h = harness();
  await h.seedCohorts();
  for (let i = 0; i < 60; i++) await h.seedTeam(`team_${String(i).padStart(2, "0")}`);
  const owner = await h.signIn(OWNER, null);
  await h.signIn("alice");
  await h.signIn("bob");
  await h.signIn("tara", null);
  await h.db.insert(teamMembers).values([
    { teamId: "team_00", userId: await h.userId("alice"), role: "admin" },
    { teamId: "team_01", userId: await h.userId("bob"), role: "write" },
  ]);
  await h.db.insert(teamTas).values({ teamId: "team_01", userId: await h.userId("tara"), assignedAt: 1 });
  await h.db.insert(benchmarks).values({
    id: "test_vision", version: 1, title: "Face recognition", contractVersion: "test-v1",
    entryPointName: "test_vision", module: "vision", summary: "Test", active: true, primaryMetricKey: "accuracy",
  });
  const run = (teamId: string, id: string, mode: "practice" | "official") => ({
    id, teamId, mode, benchmarkId: "test_vision", benchmarkVersion: 1, contractVersion: "test-v1",
    status: "succeeded" as const, branch: "main", sha: "a".repeat(40), createdAt: 1,
  });
  await h.db.insert(runs).values([
    run("team_00", "a_practice_1", "practice"),
    run("team_00", "a_practice_2", "practice"),
    run("team_00", "a_official", "official"),
    run("team_01", "b_practice", "practice"),
  ]);
  await h.db.insert(runMetrics).values({
    runId: "a_official", key: "accuracy", label: "Accuracy", value: 0.9,
    higherIsBetter: true, isPrimary: true, precision: 3,
  });
  await h.db.insert(leaderboardSelections).values({
    teamId: "team_00", benchmarkId: "test_vision", benchmarkVersion: 1, runId: "a_official", selectedAt: 1,
  });

  const before = h.statements();
  const result = await h.call("GET", "/admin/overview", { cookie: owner });
  assert.equal(result.status, 200);
  assert.ok(h.statements() - before < 50, `${h.statements() - before} D1 queries for one overview`);

  const overview: AdminOverview = result.body;
  assert.equal(overview.teams.length, 60);
  const row = (id: string) => {
    const team = overview.teams.find((candidate) => candidate.id === id);
    assert.ok(team, `${id} is missing from the overview`);
    return team;
  };
  const [a, b, empty] = [row("team_00"), row("team_01"), row("team_59")];
  assert.deepEqual(a.members.map((member) => member.login), ["alice"]);
  assert.deepEqual(b.members.map((member) => member.login), ["bob"]);
  assert.deepEqual(a.tas, []);
  assert.deepEqual(b.tas.map((ta) => ta.login), ["tara"]);
  assert.deepEqual([a.practiceUsed, a.officialUsed, b.practiceUsed, b.officialUsed], [2, 1, 1, 0]);
  assert.equal(a.published?.score, 0.9);
  assert.equal(b.published, null);
  assert.deepEqual(
    [empty.members, empty.tas, empty.practiceUsed, empty.officialUsed, empty.published],
    [[], [], 0, 0, null],
  );
});

test("a TA's overview holds their assigned live teams and nothing from any other team", async () => {
  // Owners and TAs share one summary read and differ only in the team
  // predicate they pass, so the owner test above says nothing about the TA's.
  // Dropping the assignment filter would hand a TA every team's members and
  // scores; dropping the live-cohort filter would show an old cohort's team.
  const h = harness();
  await h.seedCohorts();
  for (const id of ["team_a", "team_b", "team_c"]) await h.seedTeam(id);
  await h.seedTeam("team_old", OTHER_COHORT);
  const ta = await h.signIn("tara", null);
  const rostered = await h.signIn("rosa", null);
  for (const login of ["alice", "bob", "carol", "uma"]) await h.signIn(login);
  await h.db.insert(platformStaff).values({ login: "rosa", displayLogin: "rosa", grantedBy: OWNER, grantedAt: 1 });
  await h.db.insert(teamMembers).values([
    { teamId: "team_a", userId: await h.userId("alice"), role: "admin" },
    { teamId: "team_b", userId: await h.userId("bob"), role: "write" },
    { teamId: "team_c", userId: await h.userId("carol"), role: "admin" },
  ]);
  const taraId = await h.userId("tara");
  await h.db.insert(teamTas).values([
    { teamId: "team_a", userId: taraId, assignedAt: 1 },
    { teamId: "team_b", userId: taraId, assignedAt: 1 },
    { teamId: "team_old", userId: taraId, assignedAt: 1 },
    { teamId: "team_c", userId: await h.userId("uma"), assignedAt: 1 },
  ]);
  await h.db.insert(benchmarks).values({
    id: "test_vision", version: 1, title: "Face recognition", contractVersion: "test-v1",
    entryPointName: "test_vision", module: "vision", summary: "Test", active: true, primaryMetricKey: "accuracy",
  });
  const run = (teamId: string, id: string, mode: "practice" | "official") => ({
    id, teamId, mode, benchmarkId: "test_vision", benchmarkVersion: 1, contractVersion: "test-v1",
    status: "succeeded" as const, branch: "main", sha: "a".repeat(40), createdAt: 1,
  });
  await h.db.insert(runs).values([
    run("team_a", "a_practice", "practice"),
    run("team_a", "a_official", "official"),
    run("team_b", "b_practice_1", "practice"),
    run("team_b", "b_practice_2", "practice"),
    run("team_c", "c_practice_1", "practice"),
    run("team_c", "c_practice_2", "practice"),
    run("team_c", "c_practice_3", "practice"),
    run("team_c", "c_official", "official"),
  ]);
  const metric = { key: "accuracy", label: "Accuracy", higherIsBetter: true, isPrimary: true, precision: 3 };
  await h.db.insert(runMetrics).values([
    { ...metric, runId: "a_official", value: 0.9 },
    { ...metric, runId: "c_official", value: 0.4 },
  ]);
  await h.db.insert(leaderboardSelections).values([
    { teamId: "team_a", benchmarkId: "test_vision", benchmarkVersion: 1, runId: "a_official", selectedAt: 1 },
    { teamId: "team_c", benchmarkId: "test_vision", benchmarkVersion: 1, runId: "c_official", selectedAt: 1 },
  ]);

  const result = await h.call("GET", "/admin/overview", { cookie: ta });
  assert.equal(result.status, 200);
  const overview: AdminOverview = result.body;
  assert.equal(overview.scope, "ta");
  assert.deepEqual(
    overview.teams.map((team) => ({
      id: team.id,
      members: team.members.map((member) => member.login),
      tas: team.tas.map((assigned) => assigned.login),
      practiceUsed: team.practiceUsed,
      officialUsed: team.officialUsed,
      score: team.published?.score ?? null,
    })),
    [
      { id: "team_a", members: ["alice"], tas: ["tara"], practiceUsed: 1, officialUsed: 1, score: 0.9 },
      { id: "team_b", members: ["bob"], tas: ["tara"], practiceUsed: 2, officialUsed: 0, score: null },
    ],
  );

  // Rostered staff reach the console without an assignment, and an empty
  // assignment list must mean no teams rather than every team.
  const withoutAssignments = await h.call("GET", "/admin/overview", { cookie: rostered });
  assert.equal(withoutAssignments.status, 200);
  assert.deepEqual(withoutAssignments.body.teams, []);
});

/**
 * Two phone defects the native pass measured at `8c5a2f4`.
 *
 * Both are rendering decisions off the overview payload, so they render the
 * page from a parsed overview rather than a database: the schema is the same
 * contract the route answers with, and parsing it here keeps the fixture from
 * drifting into a shape the server cannot send.
 */

function overviewFixture(over: Partial<AdminOverview> = {}): AdminOverview {
  return AdminOverviewSchema.parse({
    scope: "owner",
    cohort: { slug: "bwsi-2026", name: "CogWorks 2026", joinCode: "VISION26", active: true },
    teams: [],
    unassigned: [],
    ...over,
  });
}

const TEAM = {
  id: "team_cosine",
  name: "Cosine Similarity Club",
  provenance: "live",
  repoFullName: "cogworks-demo/cosine-similarity-club",
  members: [],
  tas: [],
  practiceUsed: 3,
  officialUsed: 1,
  refundsGiven: 0,
  published: null,
};

function renderAdmin(overview: AdminOverview): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "overview"], overview);
  const html = renderToStaticMarkup(React.createElement(
    QueryClientProvider, { client }, React.createElement(AdminPage),
  ));
  client.clear();
  return html;
}

test("a team row gives its identity the whole width before it gives any to counts", () => {
  // Measured at 390px: the first column computed to 0px, so the name and
  // repository were the only things a phone could not see. Three auto-sized
  // fields and their gaps had taken the row.
  const html = renderAdmin(overviewFixture({ teams: [TEAM] }));

  // Narrow: two columns, identity alone on the first row, counts beneath it.
  assert.match(html, /grid-cols-\[minmax\(0,1fr\)_1\.5rem\]/);
  assert.match(html, /col-start-1 row-start-1 min-w-0/, "identity does not hold the first row");
  // Wide: the grid the native pass recorded at 768px and above, unchanged.
  assert.match(html, /sm:grid-cols-\[minmax\(0,1fr\)_auto_auto_1\.5rem\]/);
  assert.match(html, /sm:col-start-2 sm:row-start-1/, "the run state does not return to the desktop row");
  assert.match(html, /sm:col-start-3 sm:row-start-1/, "the counts do not return to the desktop row");

  // The data itself is untouched at every width.
  assert.match(html, /Cosine Similarity Club/);
  assert.match(html, /cogworks-demo\/cosine-similarity-club/);
  assert.match(html, /3 practice runs · 1 official attempt</);
});

test("staff with no assignments is not told the cohort is empty", () => {
  // A rostered TA saw "No teams yet." beside seven existing teams, because
  // the scoped list shared the owner's sentence.
  const staff = renderAdmin(overviewFixture({ scope: "ta" }));
  assert.match(staff, /No teams assigned to you yet\./);
  assert.doesNotMatch(staff, /No teams yet\./);

  const owner = renderAdmin(overviewFixture());
  assert.match(owner, /No teams yet\./);
  assert.doesNotMatch(owner, /No teams assigned to you yet\./);
});
