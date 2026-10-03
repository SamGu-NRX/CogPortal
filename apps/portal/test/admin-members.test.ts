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
import { AdminPage, TeamRunState } from "../src/routes/AdminPage.tsx";
import { formatDate } from "../src/lib/format.ts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
// AdminPage reads a held device link from sessionStorage, which Node 24 (what
// CI runs) doesn't provide. Empty, so these renders hold none.
const emptyStorage = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => emptyStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { emptyStorage.set(key, value); },
    removeItem: (key: string) => { emptyStorage.delete(key); },
  },
});

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
        repoId: repoIdOf(id),
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

test("a code shared with a closed cohort still enrolls the student in the open one", async () => {
  const h = harness();
  await h.seedCohorts();
  // Re-insert the open cohort after the closed one, so a single-row read in
  // storage order would find the closed one.
  await h.db.update(cohorts).set({ joinCode: "SHARED" }).where(eq(cohorts.id, OTHER_COHORT));
  const [open] = await h.db.select().from(cohorts).where(eq(cohorts.id, COHORT));
  assert.ok(open);
  await h.db.delete(cohorts).where(eq(cohorts.id, COHORT));
  await h.db.insert(cohorts).values({ ...open, joinCode: "SHARED" });
  const student = await h.signIn("student", null);
  const joined = await h.call("POST", "/cohorts/join", { cookie: student, body: { code: "shared" } });
  assert.equal(joined.status, 200);
  const [row] = await h.db.select({ cohortId: users.cohortId }).from(users).where(eq(users.githubLogin, "student"));
  assert.equal(row?.cohortId, COHORT);
});

test("a code two open cohorts share enrolls nobody and says why", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.db.update(cohorts).set({ joinCode: "SHARED", active: true });
  const student = await h.signIn("student", null);
  const ambiguous = await h.call("POST", "/cohorts/join", { cookie: student, body: { code: "SHARED" } });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.error.code, "invalid_request");
  assert.match(ambiguous.body.error.message, /more than one cohort/);
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
  // GitHub: the stored role is only re-read on that member's own team read
  // (routes/team.ts), and an owner of the fork cannot be demoted there at all.
  assert.equal(removed.body.error.message, "A team admin can't be removed.");
  assert.equal(await h.roleOf("team_a", creatorId), "admin");
});

test("an assigned TA can still rename a team whose members hold no admin role", async () => {
  // A team started by a write collaborator has no admin in the portal until
  // someone with admin on GitHub reads it. Its settings belong to that
  // student; the staff edit stays available through the TA's assignment.
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  const ta = await h.signIn("tara", null);
  await h.signIn("writer");
  await h.db.insert(teamMembers).values({ teamId: "team_a", userId: await h.userId("writer"), role: "write" });
  await h.db.insert(teamTas).values({ teamId: "team_a", userId: await h.userId("tara"), assignedAt: 1 });

  const renamed = await h.call("PATCH", "/admin/teams/team_a", { cookie: ta, body: { name: "Renamed by staff" } });
  assert.equal(renamed.status, 200);
  const [team] = await h.db.select({ name: teams.name }).from(teams).where(eq(teams.id, "team_a"));
  assert.equal(team?.name, "Renamed by staff");

  await h.seedTeam("team_b");
  const elsewhere = await h.call("PATCH", "/admin/teams/team_b", { cookie: ta, body: { name: "Not mine" } });
  assert.equal(elsewhere.status, 403);
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
  assert.match(html, /39 hosted runs · 30 practice and 9\u00a0official\u00a0counted/);
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
  const run = (teamId: string, id: string, mode: "practice" | "official", status: "succeeded" | "failed" = "succeeded") => ({
    id, teamId, mode, benchmarkId: "test_vision", benchmarkVersion: 1, contractVersion: "test-v1",
    status, branch: "main", sha: "a".repeat(40), createdAt: 1,
  });
  await h.db.insert(runs).values([
    // team_02 has run twice and both failed: no charged usage, but not idle.
    run("team_02", "c_practice_failed", "practice", "failed"),
    run("team_02", "c_official_failed", "official", "failed"),
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
  const [a, b, failedOnly, empty] = [row("team_00"), row("team_01"), row("team_02"), row("team_59")];
  assert.deepEqual(a.members.map((member) => member.login), ["alice"]);
  assert.deepEqual(b.members.map((member) => member.login), ["bob"]);
  assert.deepEqual(a.tas, []);
  assert.deepEqual(b.tas.map((ta) => ta.login), ["tara"]);
  assert.deepEqual([a.practiceUsed, a.officialUsed, b.practiceUsed, b.officialUsed], [2, 1, 1, 0]);
  assert.deepEqual([a.hostedRuns, b.hostedRuns, empty.hostedRuns], [3, 1, 0]);
  assert.deepEqual(
    [failedOnly.hostedRuns, failedOnly.practiceUsed, failedOnly.officialUsed],
    [2, 0, 0],
    "failed runs are executions, never charged usage",
  );
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
  hostedRuns: 6,
  refundsGiven: 0,
  firstLight: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1 },
  lastHostedRun: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1, status: "succeeded", failure: null },
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
  assert.match(html, /6 hosted runs · 3 practice and 1\u00a0official\u00a0counted</);
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

test("a team whose runs all failed reads and sorts as one that ran, not one that never started", () => {
  const never = { ...TEAM, id: "team_never", name: "Zeta never ran", practiceUsed: 0, officialUsed: 0, hostedRuns: 0, firstLight: null, lastHostedRun: null };
  const failed = { ...TEAM, id: "team_failed", name: "Alpha all failed", practiceUsed: 0, officialUsed: 0, hostedRuns: 2, firstLight: null };
  const counted = { ...TEAM, id: "team_counted", name: "Beta counted", practiceUsed: 1, officialUsed: 0, hostedRuns: 1 };
  const html = renderAdmin(overviewFixture({ teams: [counted, failed, never] }));

  assert.match(html, /2 hosted runs · none counted</, "the failed team's activity is shown");
  assert.match(html, /1 hosted run · 1 practice and 0\u00a0official\u00a0counted</);
  assert.equal((html.match(/No hosted runs yet/g) ?? []).length, 1, "only the team that never ran says so");
  // Never-ran first, then the rest by name: the failed team is among those that ran.
  const order = ["Zeta never ran", "Alpha all failed", "Beta counted"].map((name) => html.indexOf(name));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});

/**
 * Run state for staff (an assigned TA, or an owner): whether the team has run
 * end to end, and where its last hosted run stopped. The team's run pages are
 * member-only because they hold the team's own text and numbers, so the
 * server reads only platform enums and times for this, and these tests check
 * that by planting a sentinel in every field that holds the team's text.
 */

const SENTINEL = "STUDENT-TEXT-7731";
const MEASURED = "0.8731";

/** A stable repository id per team, so a seeded team and its hosted runs
 *  agree on the connected repository unless a test says otherwise. */
function repoIdOf(teamId: string): number {
  return [...teamId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_000_007, 7);
}

function hostedRun(teamId: string, id: string, over: Partial<typeof runs.$inferInsert> = {}) {
  return {
    id, teamId, repositoryId: repoIdOf(teamId),
    benchmarkId: "test_vision", benchmarkVersion: 1, contractVersion: "test-v1",
    mode: "practice" as const, status: "succeeded" as const, branch: "main", sha: "a".repeat(40),
    createdAt: 1_000, finishedAt: 1_100, ...over,
  };
}

async function seedCatalog(h: ReturnType<typeof harness>) {
  for (const [id, title] of [["test_vision", "Face recognition"], ["test_audio", "Audio identification"]] as const) {
    await h.db.insert(benchmarks).values({
      id, version: 1, title, contractVersion: "test-v1", entryPointName: id,
      module: "vision", summary: "Test", active: true, primaryMetricKey: "accuracy",
    });
  }
}

test("the overview carries a run's phase and category and none of the team's own text or numbers", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_a");
  await seedCatalog(h);
  const owner = await h.signIn(OWNER, null);
  const ta = await h.signIn("tara", null);
  await h.db.insert(teamTas).values({ teamId: "team_a", userId: await h.userId("tara"), assignedAt: 1 });
  const theirs = `${SENTINEL} at /home/student/vision.py scored ${MEASURED}`;
  await h.db.insert(runs).values([
    hostedRun("team_a", "a_scored", {
      createdAt: 1_000, finishedAt: 1_100,
      diagnosticsJson: JSON.stringify([theirs]), sweepJson: JSON.stringify({ note: theirs, value: 0.8731 }),
      wiringJson: JSON.stringify({ found: theirs }), log: theirs,
    }),
    hostedRun("team_a", "a_failed", {
      status: "failed", createdAt: 2_000, finishedAt: 2_100,
      failurePhase: "evaluating", failureCategory: "student_runtime",
      failureDetail: theirs, refusalJson: JSON.stringify({ reason: theirs }),
      diagnosticsJson: JSON.stringify([theirs]), log: theirs,
    }),
  ]);
  await h.db.insert(runMetrics).values({
    runId: "a_scored", key: "accuracy", label: "Accuracy", value: 0.8731,
    higherIsBetter: true, isPrimary: true, precision: 4,
  });

  for (const [who, cookie] of [["owner", owner], ["TA", ta]] as const) {
    const result = await h.call("GET", "/admin/overview", { cookie });
    assert.equal(result.status, 200);
    const team = result.body.teams[0];
    // The enums arrive, so the absence below is not a missing field.
    assert.deepEqual(team.lastHostedRun, {
      benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 2_100, status: "failed",
      failure: { phase: "evaluating", category: "student_runtime" },
    }, `${who}: last hosted run`);
    assert.deepEqual(team.firstLight, { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1_100 }, `${who}: first light`);
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes(SENTINEL), `${who}: the team's own text reached the overview`);
    assert.ok(!serialized.includes(MEASURED), `${who}: a measured number reached the overview`);
    assert.ok(!serialized.includes("vision.py"), `${who}: the team's file path reached the overview`);
  }
});

test("a TA's overview has run state for assigned teams only, and an unassigned team is absent", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_mine");
  await h.seedTeam("team_theirs");
  await seedCatalog(h);
  const owner = await h.signIn(OWNER, null);
  const ta = await h.signIn("tara", null);
  await h.db.insert(teamTas).values({ teamId: "team_mine", userId: await h.userId("tara"), assignedAt: 1 });
  await h.db.insert(runs).values([
    hostedRun("team_mine", "mine_scored"),
    hostedRun("team_theirs", "theirs_failed", {
      benchmarkId: "test_audio", status: "failed", createdAt: 5_000, finishedAt: 5_500,
      failurePhase: "installing", failureCategory: "dependency_install",
    }),
  ]);

  const mine = await h.call("GET", "/admin/overview", { cookie: ta });
  assert.equal(mine.status, 200);
  assert.deepEqual(
    mine.body.teams.map((team: AdminOverview["teams"][number]) => ({
      id: team.id, firstLight: team.firstLight, lastHostedRun: team.lastHostedRun,
    })),
    [{
      id: "team_mine",
      firstLight: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1_100 },
      lastHostedRun: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1_100, status: "succeeded", failure: null },
    }],
  );
  const serialized = JSON.stringify(mine.body);
  for (const leaked of ["team_theirs", "test_audio", "dependency_install", "5500"]) {
    assert.ok(!serialized.includes(leaked), `the unassigned team's ${leaked} reached the TA`);
  }

  // The owner reads the same fields for every team, so the TA's view above is
  // the assignment filter at work and not a field that is never filled in.
  const all = await h.call("GET", "/admin/overview", { cookie: owner });
  const theirs = all.body.teams.find((team: AdminOverview["teams"][number]) => team.id === "team_theirs");
  assert.deepEqual(theirs?.lastHostedRun, {
    benchmarkId: "test_audio", benchmarkTitle: "Audio identification", at: 5_500, status: "failed",
    failure: { phase: "installing", category: "dependency_install" },
  });
  assert.equal(theirs?.firstLight, null);
});

test("first light is the earliest finished success across benchmarks, and the last run is the latest started", async () => {
  const h = harness();
  await h.seedCohorts();
  for (const id of ["team_mixed", "team_running", "team_unrecorded", "team_never"]) await h.seedTeam(id);
  await seedCatalog(h);
  // A later version of the vision benchmark under another title: a run is
  // named by its own version, not by whichever row the catalog lists first.
  await h.db.insert(benchmarks).values({
    id: "test_vision", version: 2, title: "Face recognition, revised", contractVersion: "test-v1",
    entryPointName: "test_vision", module: "vision", summary: "Test", active: true, primaryMetricKey: "accuracy",
  });
  const owner = await h.signIn(OWNER, null);
  await h.db.insert(runs).values([
    hostedRun("team_mixed", "m_failed_first", {
      status: "failed", createdAt: 100, finishedAt: 150,
      failurePhase: "installing", failureCategory: "dependency_install",
    }),
    // Started before the audio success but finished after it: first light is
    // when a run went end to end, so the audio run is first.
    hostedRun("team_mixed", "m_vision_scored", { createdAt: 180, finishedAt: 300 }),
    hostedRun("team_mixed", "m_audio_scored", { benchmarkId: "test_audio", createdAt: 200, finishedAt: 260 }),
    // A success with no finish time, started before both: the Team page
    // doesn't count it, so first light doesn't either.
    hostedRun("team_mixed", "m_undated_success", { createdAt: 120, finishedAt: null }),
    // Finished last, but started before the failure below.
    hostedRun("team_mixed", "m_cancelled", {
      benchmarkId: "test_audio", status: "cancelled", createdAt: 350, finishedAt: 900,
    }),
    hostedRun("team_mixed", "m_failed_last", {
      status: "failed", createdAt: 400, finishedAt: 420,
      failurePhase: "contract_check", failureCategory: "adapter_missing",
    }),
    hostedRun("team_running", "r_failed", {
      status: "failed", createdAt: 100, finishedAt: 120,
      failurePhase: "scoring", failureCategory: "scorer",
    }),
    hostedRun("team_running", "r_evaluating", {
      benchmarkVersion: 2, status: "evaluating", createdAt: 500, finishedAt: null,
    }),
    // Failed with no phase or category recorded: nothing to say where. Its
    // benchmark has no catalog row, so the id stands in for the title.
    hostedRun("team_unrecorded", "u_failed", {
      benchmarkId: "test_retired", status: "failed", createdAt: 100, finishedAt: 130,
    }),
  ]);

  const result = await h.call("GET", "/admin/overview", { cookie: owner });
  assert.equal(result.status, 200);
  const state = Object.fromEntries(
    (result.body as AdminOverview).teams.map((team) => [team.id, { firstLight: team.firstLight, lastHostedRun: team.lastHostedRun }]),
  );
  assert.deepEqual(state, {
    team_mixed: {
      firstLight: { benchmarkId: "test_audio", benchmarkTitle: "Audio identification", at: 260 },
      lastHostedRun: {
        benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 420, status: "failed",
        failure: { phase: "contract_check", category: "adapter_missing" },
      },
    },
    team_running: {
      firstLight: null,
      lastHostedRun: {
        benchmarkId: "test_vision", benchmarkTitle: "Face recognition, revised", at: 500,
        status: "evaluating", failure: null,
      },
    },
    team_unrecorded: {
      firstLight: null,
      lastHostedRun: {
        benchmarkId: "test_retired", benchmarkTitle: "test_retired", at: 130, status: "failed", failure: null,
      },
    },
    team_never: { firstLight: null, lastHostedRun: null },
  });
});

/** The text of each paragraph, tags removed: the times and the failure code
 *  are wrapped in their own elements, and a reader sees one sentence. */
function sentences(html: string): string[] {
  const entities: Record<string, string> = { "&#x27;": "'", "&quot;": "\"", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
  return [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((match) =>
    match[1]!.replace(/<[^>]+>/g, "").replace(/&#x27;|&quot;|&lt;|&gt;|&amp;/g, (entity) => entities[entity]!));
}

function renderRunState(team: Pick<AdminOverview["teams"][number], "firstLight" | "lastHostedRun">): string[] {
  return sentences(renderToStaticMarkup(React.createElement(TeamRunState, { team })));
}

test("the run state says, in the platform's words, where each kind of team stands", () => {
  const firstAt = Date.UTC(2026, 8, 29, 14, 5);
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1_000;
  const firstLight = { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: firstAt };
  const firstSentence = `First ran end to end from this repository on Face recognition, ${formatDate(firstAt)}.`;

  assert.deepEqual(renderRunState({ firstLight: null, lastHostedRun: null }), ["Hasn't run end to end from this repository yet."]);
  assert.deepEqual(
    renderRunState({
      firstLight: null,
      lastHostedRun: {
        benchmarkId: "test_audio", benchmarkTitle: "Audio identification", at: threeHoursAgo, status: "failed",
        failure: { phase: "installing", category: "dependency_install" },
      },
    }),
    [
      "Hasn't run end to end from this repository yet.",
      "Last hosted run: Audio identification, 3 h ago, failed at Install. Dependency installation failed (E-INSTALL).",
    ],
  );
  assert.deepEqual(
    renderRunState({
      firstLight,
      lastHostedRun: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: threeHoursAgo, status: "succeeded", failure: null },
    }),
    [firstSentence, "Last hosted run: Face recognition, 3 h ago, scored."],
  );
  // Queued too: it is one of the statuses the database counts as an active
  // run. The sentence says what the overview saw, not that a run is going now.
  for (const status of ["queued", "evaluating"] as const) {
    assert.deepEqual(
      renderRunState({
        firstLight,
        lastHostedRun: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: threeHoursAgo, status, failure: null },
      }),
      [firstSentence, "Last hosted run: Face recognition, 3 h ago, no result yet."],
      status,
    );
  }
  assert.deepEqual(
    renderRunState({
      firstLight,
      lastHostedRun: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: threeHoursAgo, status: "cancelled", failure: null },
    })[1],
    "Last hosted run: Face recognition, 3 h ago, cancelled.",
  );
  assert.deepEqual(
    renderRunState({
      firstLight: null,
      lastHostedRun: {
        benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: threeHoursAgo, status: "failed",
        failure: { phase: "evaluating", category: "student_runtime" },
      },
    })[1],
    "Last hosted run: Face recognition, 3 h ago, failed at Evaluate. The evaluation stopped on an exception (E-RUNTIME).",
  );
  assert.deepEqual(
    renderRunState({
      firstLight: null,
      lastHostedRun: { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: threeHoursAgo, status: "failed", failure: null },
    })[1],
    "Last hosted run: Face recognition, 3 h ago, failed.",
  );
});

test("only teams that haven't run end to end carry the attention mark, and they sort first", () => {
  const ran = { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1, status: "succeeded" as const, failure: null };
  const teams = [
    { ...TEAM, id: "t_scored", name: "Alpha scored", lastHostedRun: ran },
    { ...TEAM, id: "t_going", name: "Beta going", lastHostedRun: { ...ran, status: "evaluating" as const } },
    {
      ...TEAM, id: "t_not_yet", name: "Gamma not yet", practiceUsed: 0, officialUsed: 0, hostedRuns: 2, firstLight: null,
      lastHostedRun: { ...ran, status: "failed" as const, failure: { phase: "contract_check" as const, category: "adapter_missing" as const } },
    },
    { ...TEAM, id: "t_never", name: "Zeta never", practiceUsed: 0, officialUsed: 0, hostedRuns: 0, firstLight: null, lastHostedRun: null },
  ];
  const html = renderAdmin(overviewFixture({ scope: "ta", teams }));
  const rows = html.split("<li").slice(1);
  const rowFor = (name: string) => {
    const row = rows.find((candidate) => candidate.includes(`>${name}<`));
    assert.ok(row, `no row for ${name}`);
    return row;
  };
  const marked = (row: string) => (row.match(/rounded-full bg-detect/g) ?? []).length;

  assert.equal(marked(rowFor("Zeta never")), 1);
  assert.match(rowFor("Zeta never"), /No hosted runs yet/);
  assert.equal(marked(rowFor("Gamma not yet")), 1);
  assert.match(rowFor("Gamma not yet"), /Not end to end yet/);
  // The counts stay beneath it, so a TA still sees that the team ran.
  assert.match(rowFor("Gamma not yet"), /Not end to end yet<\/span><\/span><span class="[^"]*text-ink-secondary[^"]*">2 hosted runs · none counted</);
  for (const name of ["Alpha scored", "Beta going"]) {
    assert.equal(marked(rowFor(name)), 0, `${name} is marked`);
    assert.doesNotMatch(rowFor(name), /Not end to end yet|No hosted runs yet/);
  }

  const order = ["Zeta never", "Gamma not yet", "Alpha scored", "Beta going"].map((name) => html.indexOf(`>${name}<`));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});

// Run state describes the repository the row names. A team that moved from
// repository A to B, with a success on A and nothing yet on B, belongs in the
// attention group, and the move erases none of its team-wide history.
test("run state counts only the connected repository, and moving repository keeps the counts", async () => {
  const h = harness();
  await h.seedCohorts();
  await h.seedTeam("team_moved");
  await seedCatalog(h);
  const owner = await h.signIn(OWNER, null);
  const repoB = repoIdOf("team_moved") + 1;
  await h.db.insert(runs).values([
    hostedRun("team_moved", "a_scored", { createdAt: 1_000, finishedAt: 1_100 }),
    hostedRun("team_moved", "a_failed", {
      status: "failed", createdAt: 2_000, finishedAt: 2_100,
      failurePhase: "evaluating", failureCategory: "student_runtime",
    }),
    // Before migration 0013 a run recorded no repository id, so it speaks for
    // no repository, as on the Team page.
    hostedRun("team_moved", "legacy_scored", { repositoryId: null, createdAt: 500, finishedAt: 600 }),
  ]);
  const read = async () => {
    const result = await h.call("GET", "/admin/overview", { cookie: owner });
    assert.equal(result.status, 200);
    const team = (result.body as AdminOverview).teams.find((entry) => entry.id === "team_moved");
    assert.ok(team, "the moved team's row");
    return team;
  };

  const onA = await read();
  assert.deepEqual(onA.firstLight, { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 1_100 });
  assert.equal(onA.lastHostedRun?.status, "failed");

  await h.db.update(teams)
    .set({ repoId: repoB, repoName: "moved-b", repoFullName: "cogworks-test/moved-b" })
    .where(eq(teams.id, "team_moved"));
  const onB = await read();
  assert.equal(onB.firstLight, null);
  assert.equal(onB.lastHostedRun, null);
  assert.equal(onB.hostedRuns, onA.hostedRuns, "moving repository keeps the team-wide count");
  assert.equal(onB.practiceUsed, onA.practiceUsed, "moving repository keeps the quota");

  await h.db.insert(runs).values(hostedRun("team_moved", "b_failed", {
    repositoryId: repoB, status: "failed", createdAt: 3_000, finishedAt: 3_100,
    failurePhase: "contract_check", failureCategory: "adapter_missing",
  }));
  const failedOnB = await read();
  assert.equal(failedOnB.firstLight, null);
  assert.equal(failedOnB.lastHostedRun?.at, 3_100);
  assert.deepEqual(failedOnB.lastHostedRun?.failure, { phase: "contract_check", category: "adapter_missing" });

  await h.db.insert(runs).values(hostedRun("team_moved", "b_scored", { repositoryId: repoB, createdAt: 4_000, finishedAt: 4_100 }));
  const scoredOnB = await read();
  assert.deepEqual(scoredOnB.firstLight, { benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: 4_100 });
  assert.equal(scoredOnB.lastHostedRun?.status, "succeeded");
  assert.equal(scoredOnB.lastHostedRun?.at, 4_100);
});
