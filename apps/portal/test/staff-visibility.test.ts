import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createAuth } from "../worker/auth/better-auth.ts";
import { staffVisibilitySetting } from "../worker/services/staff-visibility.ts";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  leaderboardSelections,
  runMetrics,
  runs,
  teamMembers,
  teamProcessSignals,
  teamTas,
  teams,
  users,
} from "../worker/db/schema.ts";
import { validateServerEnv } from "../worker/env.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerAdminRoutes } from "../worker/routes/admin.ts";
import { registerRunRoutes } from "../worker/routes/runs.ts";
import { registerStaffDeskRoutes } from "../worker/routes/staff-desk.ts";

/**
 * The staff visibility switch (worker/services/staff-visibility.ts), measured on
 * the real admin, desk and run routes over in-memory migrations. Each
 * property is checked under both settings: "assigned-teams" (today's TA view,
 * the default) and "restricted" (the proposal). What may differ between them
 * is only what a TA reads about students; what must hold under both is that
 * owners read everything and that a run's own text never reaches anyone
 * outside its team.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const OWNER = "AdaOwner";
const TA = "Tessa";
// Synthetic people. The strings are distinctive so a leak is findable in any
// response body.
const STUDENTS = ["zq-student-one", "zq-student-two"];
const OTHER_STUDENT = "zq-other-team";
const SCORE = 0.8125;
const LOG_TEXT = "zq-private-traceback-from-team-a";
const DETAIL_TEXT = "zq-private-failure-detail";

/** In-memory D1, with the batch syncRun writes through (fixture-failure-wording.test.ts). */
function freshBinding(): unknown {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !/^(0002_seed|0016_backfill)/.test(file));
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  function prepare(query: string) {
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
      execute() {
        const results = statement.all(...bound);
        const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
        return { success: true, results, meta: { changes } };
      },
      async all() {
        return prepared.execute();
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
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
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
}

type Setting = "assigned-teams" | "restricted" | undefined;

async function world(setting: Setting) {
  const binding = freshBinding();
  const env = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
    PLATFORM_OWNER_LOGINS: OWNER,
    ...(setting ? { STAFF_VISIBILITY: setting } : {}),
  } as unknown as Env;
  const db = drizzle(binding as never) as unknown as Database;
  const app = new Hono<AppEnv>();
  registerAdminRoutes(app);
  registerStaffDeskRoutes(app);
  registerRunRoutes(app);
  app.onError(handleError);

  async function signIn(githubLogin: string): Promise<{ cookie: string; id: string }> {
    const result = await createAuth(env).api.signUpEmail({
      body: { email: `${githubLogin.toLowerCase()}@users.noreply.github.com`, password: "cogportal-local-dev-password", name: githubLogin },
      returnHeaders: true,
    });
    await db.update(users).set({ githubLogin, cohortId: "cohort_test" }).where(eq(users.id, result.response.user.id));
    return {
      cookie: result.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "),
      id: result.response.user.id,
    };
  }

  async function call(method: string, path: string, cookie?: string, body?: unknown) {
    const response = await app.fetch(
      new Request(`http://localhost:5173${path}`, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    );
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  }

  await db.insert(cohorts).values({ id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true });
  for (const [id, name, repoId] of [["team_a", "Team A", 101], ["team_b", "Team B", 102]] as const) {
    await db.insert(teams).values({
      id,
      cohortId: "cohort_test",
      name,
      description: null,
      repoOwner: "course",
      repoName: id,
      repoFullName: `course/${id}`,
      repoUrl: `https://github.com/course/${id}`,
      defaultBranch: "main",
      repoId,
      provenance: "live",
    });
  }
  await db
    .insert(benchmarks)
    .values({
      id: "audio-identification",
      version: 1,
      contractVersion: "cogworks.submissions.v2",
      entryPointName: "audio-identification",
      title: "Audio identification",
      module: "audio",
      summary: "Test",
      active: true,
      primaryMetricKey: "accuracy",
      scorerVersion: "1",
    })
    .onConflictDoUpdate({ target: [benchmarks.id, benchmarks.version], set: { module: "audio", scorerVersion: "1", primaryMetricKey: "accuracy" } });

  const owner = await signIn(OWNER);
  const ta = await signIn(TA);
  const students = await Promise.all(STUDENTS.map(signIn));
  const other = await signIn(OTHER_STUDENT);
  await db.insert(teamMembers).values([
    { teamId: "team_a", userId: students[0].id, role: "admin" },
    { teamId: "team_a", userId: students[1].id, role: "write" },
    { teamId: "team_b", userId: other.id, role: "admin" },
  ]);
  await db.insert(teamTas).values({ teamId: "team_a", userId: ta.id, assignedAt: 1 });

  const base = {
    teamId: "team_a",
    benchmarkId: "audio-identification",
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v2",
    branch: "main",
    sha: "a".repeat(40),
    provider: "fixture" as const,
    repositoryId: 101,
    repositoryFullName: "course/team_a",
  };
  await db.insert(runs).values([
    { ...base, id: "run_official", mode: "official", status: "succeeded", createdAt: 1_789_000_000_000, finishedAt: 1_789_000_100_000, attemptNumber: 1, scorerVersion: "1" },
    {
      ...base,
      id: "run_failed",
      mode: "practice",
      status: "failed",
      createdAt: 1_789_000_200_000,
      finishedAt: 1_789_000_300_000,
      failurePhase: "evaluating",
      failureCategory: "student_runtime",
      failureDetail: DETAIL_TEXT,
      log: LOG_TEXT,
    },
  ]);
  await db.insert(runMetrics).values({ runId: "run_official", key: "accuracy", label: "Accuracy", value: SCORE, unit: null, higherIsBetter: true, isPrimary: true, precision: 3 });
  await db.insert(leaderboardSelections).values({ teamId: "team_a", benchmarkId: "audio-identification", benchmarkVersion: 1, runId: "run_official", selectedAt: 1_789_000_150_000 });
  const checkedAt = Date.now() - 60_000;
  await db.insert(teamProcessSignals).values({
    teamId: "team_a",
    computedAt: 0,
    historyQuality: "usable",
    signalsJson: JSON.stringify({
      kind: "commit-history.v1",
      repository: "course/team_a",
      branch: "main",
      checkedAt,
      result: {
        ok: true,
        truncated: false,
        commits: [
          { sha: "1".repeat(40), authorLogin: STUDENTS[0], authoredAt: checkedAt - 500, filesChanged: ["src/spectrogram.py"], coAuthors: [] },
          { sha: "2".repeat(40), authorLogin: STUDENTS[1], authoredAt: checkedAt - 400, filesChanged: ["src/peaks.py"], coAuthors: [] },
        ],
      },
    }),
  });

  /** Everything a TA can read about team A on the staff surfaces. */
  async function taReads() {
    return {
      overview: await call("GET", "/admin/overview", ta.cookie),
      list: await call("GET", "/admin/desk/teams", ta.cookie),
      detail: await call("GET", "/admin/desk/teams/team_a", ta.cookie),
      runs: await call("GET", "/admin/desk/teams/team_a/runs", ta.cookie),
    };
  }
  return { env, call, owner, ta, students, other, taReads };
}

const SETTINGS: Setting[] = [undefined, "assigned-teams", "restricted"];

test("by default a TA reads today's view: member logins, run counts, the latest published score, findings", async () => {
  for (const setting of [undefined, "assigned-teams"] as const) {
    const w = await world(setting);
    const { overview, detail } = await w.taReads();
    assert.equal(overview.status, 200, overview.text);
    assert.equal(overview.body.view, "full");
    const [team] = overview.body.teams;
    assert.deepEqual(team.members.map((m: { login: string }) => m.login).sort(), [...STUDENTS].sort());
    assert.equal(team.memberCount, 2);
    assert.equal(team.hostedRuns, 2);
    assert.equal(team.published?.score, SCORE);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.view, "full");
    assert.equal(detail.body.team.members.length, 2);
    assert.ok(detail.body.commitSignals?.findingSentences.length > 0, `findings under ${setting}`);
  }
});

test("restricted: a TA reads no student names, scores, metrics or findings, and keeps team-level state", async () => {
  const w = await world("restricted");
  const reads = await w.taReads();
  for (const [name, response] of Object.entries(reads)) {
    assert.equal(response.status, 200, `${name}: ${response.text}`);
    assert.equal(response.body.view, "restricted", name);
    for (const login of STUDENTS) assert.ok(!response.text.includes(login), `${name} names ${login}`);
    assert.ok(!response.text.includes(String(SCORE)), `${name} carries the score`);
  }
  const [team] = reads.overview.body.teams;
  assert.deepEqual(team.members, []);
  assert.equal(team.memberCount, 2, "how many people is a team-level fact");
  assert.equal(team.published, null);
  assert.equal(team.hostedRuns, 2);
  assert.equal(team.lastHostedRun.failure.category, "student_runtime", "failure categories stay");
  assert.equal(reads.detail.body.commitSignals, null);
  assert.deepEqual(reads.detail.body.team.members, []);
  assert.equal(reads.detail.body.team.memberCount, 2);
  assert.equal(reads.detail.body.history.status, "fresh", "the read's state is still reported");
  assert.equal(reads.runs.body.runs.length, 2, "run states stay");
});

test("restricted: a TA cannot edit membership they cannot see", async () => {
  const w = await world("restricted");
  const add = await w.call("POST", "/admin/teams/team_a/members", w.ta.cookie, { login: OTHER_STUDENT });
  assert.equal(add.status, 403, add.text);
  const remove = await w.call("DELETE", `/admin/teams/team_a/members/${STUDENTS[1]}`, w.ta.cookie);
  assert.equal(remove.status, 403, remove.text);
  // Renaming is not a membership edit; its answer is withheld the same way.
  const rename = await w.call("PATCH", "/admin/teams/team_a", w.ta.cookie, { name: "Team A renamed" });
  assert.equal(rename.status, 200, rename.text);
  assert.deepEqual(rename.body.members, []);
  assert.equal(rename.body.published, null);
});

test("owners read everything under either setting", async () => {
  for (const setting of SETTINGS) {
    const w = await world(setting);
    const overview = await w.call("GET", "/admin/overview", w.owner.cookie);
    assert.equal(overview.body.view, "full", String(setting));
    const teamA = overview.body.teams.find((team: { id: string }) => team.id === "team_a");
    assert.equal(teamA.members.length, 2);
    assert.equal(teamA.published?.score, SCORE);
    const detail = await w.call("GET", "/admin/desk/teams/team_a", w.owner.cookie);
    assert.ok(detail.body.commitSignals, String(setting));
  }
});

test("under either setting a run's log and detail reach only its own team", async () => {
  for (const setting of SETTINGS) {
    const w = await world(setting);
    // The team's own member reads its run, text included.
    const own = await w.call("GET", "/runs/run_failed", w.students[0].cookie);
    assert.equal(own.status, 200, own.text);
    assert.ok(own.text.includes(DETAIL_TEXT));
    // Another team's student cannot, and the answer does not say the run exists.
    const other = await w.call("GET", "/runs/run_failed", w.other.cookie);
    assert.equal(other.status, 404, `${setting}: ${other.text}`);
    assert.ok(!other.text.includes(LOG_TEXT) && !other.text.includes(DETAIL_TEXT));
    // Staff surfaces carry neither, for TAs or owners.
    const reads = { ...(await w.taReads()), ownerRuns: await w.call("GET", "/admin/desk/teams/team_a/runs", w.owner.cookie) };
    for (const [name, response] of Object.entries(reads)) {
      assert.ok(!response.text.includes(LOG_TEXT), `${setting} ${name} carries the log`);
      assert.ok(!response.text.includes(DETAIL_TEXT), `${setting} ${name} carries the failure detail`);
    }
    // And a student is not staff under either setting.
    assert.equal((await w.call("GET", "/admin/desk/teams/team_a", w.other.cookie)).status, 403);
  }
});

test("a misspelled setting fails loudly rather than picking one", () => {
  assert.throws(() => staffVisibilitySetting({ STAFF_VISIBILITY: "restrict" as never }), /STAFF_VISIBILITY must be one of/);
  assert.throws(() =>
    validateServerEnv({
      ENVIRONMENT: "development",
      DEV_AUTH: "enabled",
      EXECUTION_PROVIDER: "fixture",
      STAFF_VISIBILITY: "everything",
    } as never),
  );
  assert.equal(staffVisibilitySetting({}), "assigned-teams");
});
