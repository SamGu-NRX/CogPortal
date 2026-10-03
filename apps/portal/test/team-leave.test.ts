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
import { LocalReportInputSchema, type LocalRunEvent } from "@cogworks/contracts/schema";
import { createAuth } from "../worker/auth/better-auth.ts";
import {
  benchmarks, cliDevices, cohorts, leaderboardSelections, localRunSessions,
  officialAttempts, runs, runSurfaces, teamMembers, teams, teamTas, users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerLocalReportRoutes } from "../worker/routes/local-reports.ts";
import { LEFT_RUN_TEAM, registerLocalRunRoutes } from "../worker/routes/local-runs.ts";
import { registerTeamMembershipRoutes } from "../worker/routes/team-membership.ts";
import { getTeamDetail } from "../worker/routes/team.ts";
import { getLatestTeamWeights } from "../worker/services/local-reports.ts";
import { sha256Hex } from "../worker/util/crypto.ts";
import { runSurfaceHubs } from "./fixtures/run-surface-hub.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const DEVICE_TOKEN = "cog_teamleavetesttoken";
const BENCHMARK = "test-team-leave-benchmark";
const SESSION = `localrun_${"a".repeat(32)}`;
const SHA = "b".repeat(40);
const NOW = 1_780_000_000_000;
const REPORT_LEFT_TEAM =
  "This report belongs to a run on a team you've left, so it can't be changed now. Your copy on this machine is unchanged.";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const race: { beforeBatch?: () => void } = {};
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
      // A leave can commit after admission reads but before D1 starts its batch.
      const beforeBatch = race.beforeBatch;
      delete race.beforeBatch;
      beforeBatch?.();
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
  return { sqlite, race, binding, db: drizzle(binding as never) };
}

async function harness(t: TestContext) {
  const { sqlite, race, binding, db } = freshDb();
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
  registerTeamMembershipRoutes(routes);
  registerLocalRunRoutes(routes);
  registerLocalReportRoutes(routes);
  const app = new Hono<AppEnv>();
  app.route("/api", routes);
  app.onError(handleError);

  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true,
  });
  const auth = createAuth(env);
  const signedIn = await auth.api.signUpEmail({
    body: { email: "ada@users.noreply.github.com", password: "cogportal-local-dev-password", name: "Ada" },
    returnHeaders: true,
  });
  const userId = signedIn.response.user.id;
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  await db.update(users).set({ githubLogin: "ada", cohortId: "cohort_test" }).where(eq(users.id, userId));
  await db.insert(teams).values({
    id: "team_a", cohortId: "cohort_test", name: "Team A",
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name,
    repoFullName: FIXTURE_REPO.fullName, repoUrl: FIXTURE_REPO.url,
    defaultBranch: FIXTURE_REPO.defaultBranch, repoId: FIXTURE_REPO.repositoryId,
    discordChannelId: "channel_a",
  });
  await db.insert(teamMembers).values({ teamId: "team_a", userId, role: "admin" });
  await db.insert(benchmarks).values({
    id: BENCHMARK, version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: "submission",
    title: "Test benchmark", module: "vision", summary: "Synthetic leave test", active: true,
    primaryMetricKey: "accuracy", pluginVersion: "1", datasetVersion: "official-v1",
    scorerVersion: "1", runtimeVersion: "python-3.11", sandboxContract: 1,
  });
  await db.insert(cliDevices).values({
    id: "device_test", userId, name: "Test laptop", tokenHash: await sha256Hex(DEVICE_TOKEN),
    createdAt: NOW, expiresAt: Date.now() + 86_400_000,
  });

  // An accepted event publishes its console in the background.
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (work: Promise<unknown>) => { background.push(work); },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  async function call(method: string, path: string, options: {
    cookie?: string; device?: boolean; body?: unknown;
  } = {}) {
    const response = await app.fetch(new Request(`http://localhost:5173/api${path}`, {
      method,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.device ? { Authorization: `Bearer ${DEVICE_TOKEN}` } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }), env, executionCtx);
    return { status: response.status, body: await response.json() as unknown };
  }
  const leave = (teamId = "team_a") => call("POST", "/team/leave", { cookie, body: { teamId } });
  const rows = (table: string) => sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  async function joinB() {
    await db.insert(teams).values({
      id: "team_b", cohortId: "cohort_test", name: "Difference Engines",
      repoOwner: "synthetic", repoName: "team-b", repoFullName: "synthetic/team-b",
      repoUrl: "https://github.com/synthetic/team-b", defaultBranch: "main", discordChannelId: "channel_b",
    });
    await db.insert(teamMembers).values({ teamId: "team_b", userId, role: "write" });
  }
  async function seedSession(reportId: string | null = null) {
    await db.insert(runSurfaces).values({
      id: "surface_test", teamId: "team_a", createdByUserId: userId,
      benchmarkId: BENCHMARK, benchmarkVersion: 1, localRunId: SESSION,
      discordChannelId: "channel_a", createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(localRunSessions).values({
      id: SESSION, teamId: "team_a", userId, deviceId: "device_test",
      benchmarkId: BENCHMARK, benchmarkVersion: 1, repositoryId: FIXTURE_REPO.repositoryId,
      repositoryFullName: FIXTURE_REPO.fullName, sha: SHA, branch: "main", dirty: false,
      status: "running", phase: "evaluating", lastEventSequence: 0,
      reportId, surfaceId: "surface_test", createdAt: NOW, updatedAt: NOW,
    });
  }
  return { db, env, sqlite, race, hubs, userId, cookie, call, leave, rows, joinB, seedSession };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function report(reportId = "report_team_leave", accuracy = 0.82) {
  return LocalReportInputSchema.parse({
    reportId, benchmarkId: BENCHMARK, benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1", sdkVersion: "0.2.0", pluginVersion: "1",
    repositoryId: FIXTURE_REPO.repositoryId, repositoryFullName: FIXTURE_REPO.fullName,
    sha: SHA, dirty: false, startedAt: NOW, finishedAt: NOW + 1_000,
    metrics: [{ key: "accuracy", label: "Accuracy", value: accuracy, unit: null,
      higherIsBetter: true, primary: true, precision: 3 }],
    diagnostics: [], weightsUsed: [],
  });
}

function event(kind: "progress" | "completed"): LocalRunEvent {
  const base = { eventId: `localevent_team_leave_${kind}`, sequence: 1, occurredAt: NOW + 1_000 };
  return kind === "progress"
    ? { ...base, type: "progress", phase: "evaluating" }
    : { ...base, type: "completed", report: report() };
}

async function seedHostedRun(h: Harness, id: string, status: "queued" | "succeeded", mode: "practice" | "official") {
  await h.db.insert(runs).values({
    id, teamId: "team_a", benchmarkId: BENCHMARK, benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1", mode, status, branch: "main", sha: SHA,
    repositoryId: FIXTURE_REPO.repositoryId, repositoryFullName: FIXTURE_REPO.fullName,
    createdAt: NOW, finishedAt: status === "succeeded" ? NOW + 1_000 : null,
  });
}

test("leave removes only the caller, preserving teammates and team history", async (t) => {
  const h = await harness(t);
  await h.db.insert(users).values([
    { id: "teammate", name: "Grace", email: "grace@example.test" },
    { id: "ta", name: "Test TA", email: "ta@example.test" },
  ]);
  await h.db.insert(teamMembers).values({ teamId: "team_a", userId: "teammate", role: "write" });
  await h.db.insert(teamTas).values({ teamId: "team_a", userId: "ta", assignedAt: NOW });
  await seedHostedRun(h, "run_practice", "queued", "practice");
  await seedHostedRun(h, "run_official", "succeeded", "official");
  await h.db.insert(officialAttempts).values({
    id: "attempt_test", teamId: "team_a", benchmarkId: BENCHMARK, benchmarkVersion: 1,
    runId: "run_official", attemptNumber: 1, consumed: true, claimedAt: NOW,
  });
  await h.db.insert(leaderboardSelections).values({
    teamId: "team_a", benchmarkId: BENCHMARK, benchmarkVersion: 1, runId: "run_official", selectedAt: NOW,
  });
  const preserved = ["teams", "runs", "team_tas", "official_attempts", "leaderboard_selections"];
  const before = preserved.map(h.rows);
  const teammates = h.rows("team_members").filter((row) => row.user_id !== h.userId);
  assert.deepEqual(await h.leave(), { status: 200, body: { alreadyLeft: false } });
  assert.deepEqual(h.rows("team_members"), teammates);
  assert.deepEqual(preserved.map(h.rows), before);
});

test("the last member and only admin can leave, and GET lists the empty team", async (t) => {
  const h = await harness(t);
  const before = h.rows("teams");
  assert.deepEqual(await h.leave(), { status: 200, body: { alreadyLeft: false } });
  assert.deepEqual(h.rows("teams"), before);
  assert.deepEqual(h.rows("team_members"), []);
  const listing = await h.call("GET", "/cohorts/teams", { cookie: h.cookie });
  assert.equal(listing.status, 200);
  const listed = listing.body as Array<{ id: string; members: unknown[]; adminLogin: string | null }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "team_a");
  assert.deepEqual(listed[0].members, []);
  assert.equal(listed[0].adminLogin, null);
});

test("repeating leave returns alreadyLeft and changes no team data", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.leave(), { status: 200, body: { alreadyLeft: false } });
  const preserved = ["team_members", "teams", "runs", "team_tas", "official_attempts", "leaderboard_selections"];
  const before = preserved.map(h.rows);
  assert.deepEqual(await h.leave(), { status: 200, body: { alreadyLeft: true } });
  assert.deepEqual(preserved.map(h.rows), before);
});

for (const formerlyMember of [true, false]) {
  test(formerlyMember
    ? "a stale leave for A names the current team B and preserves its membership"
    : "leave cannot remove B when the caller names a team they never joined", async (t) => {
    const h = await harness(t);
    assert.equal((await h.leave()).status, 200);
    await h.joinB();
    if (!formerlyMember) {
      await h.db.insert(teams).values({
        id: "team_never_joined", cohortId: "cohort_test", name: "Unjoined team",
        repoOwner: "synthetic", repoName: "unjoined", repoFullName: "synthetic/unjoined",
        repoUrl: "https://github.com/synthetic/unjoined", defaultBranch: "main",
      });
      await h.db.insert(users).values({ id: "other_member", name: "Other member", email: "other@example.test" });
      await h.db.insert(teamMembers).values({ teamId: "team_never_joined", userId: "other_member", role: "admin" });
    }
    const before = h.rows("team_members");
    const result = await h.leave(formerlyMember ? "team_a" : "team_never_joined");
    assert.deepEqual(result, { status: 409, body: { error: {
      code: "already_on_team",
      message: "You're on Difference Engines now, not the team this page showed. Reload to see it.",
    } } });
    assert.deepEqual(h.rows("team_members"), before);
    assert.equal(before[0].team_id, "team_b");
  });
}

test("a valid device credential without a cookie cannot leave", async (t) => {
  const h = await harness(t);
  const before = h.rows("team_members");
  const result = await h.call("POST", "/team/leave", { device: true, body: { teamId: "team_a" } });
  assert.equal(result.status, 401);
  assert.equal((result.body as { error: { code: string } }).error.code, "unauthorized");
  assert.deepEqual(h.rows("team_members"), before);
});

test("the last member can rejoin the empty fixture team through the join route", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.leave(), { status: 200, body: { alreadyLeft: false } });
  const result = await h.call("POST", "/team/join", { cookie: h.cookie, body: { teamId: "team_a" } });
  assert.equal(result.status, 200);
  const membership = await h.db.select().from(teamMembers);
  assert.equal(membership.length, 1);
  assert.equal(membership[0].teamId, "team_a");
  assert.equal(membership[0].userId, h.userId);
  assert.equal(membership[0].role, "write");
});

for (const transport of ["single", "batch"] as const) {
  for (const kind of ["progress", "completed"] as const) {
    test(`${transport} ${kind} after leave cannot write to A, even after joining B`, async (t) => {
      const h = await harness(t);
      await h.seedSession();
      assert.equal((await h.leave()).status, 200);
      const preserved = ["local_run_sessions", "run_surfaces", "run_stream_events", "local_reports"];
      const before = preserved.map(h.rows);
      for (const onB of [false, true]) {
        if (onB) await h.joinB();
        const memberships = h.rows("team_members");
        const result = await h.call("POST", `/v1/local-runs/${SESSION}/events${transport === "batch" ? "/batch" : ""}`, {
          device: true, body: transport === "batch" ? { events: [event(kind)] } : event(kind),
        });
        assert.deepEqual(result, { status: 403, body: { error: { code: "forbidden", message: LEFT_RUN_TEAM } } });
        assert.deepEqual(preserved.map(h.rows), before, "refused events must not write sessions, consoles, events, or reports");
        assert.deepEqual(h.rows("team_members"), memberships);
        assert.equal(h.rows("local_run_sessions")[0].last_event_sequence, 0);
        assert.equal(h.rows("local_run_sessions")[0].status, "running");
        assert.deepEqual(h.rows("run_stream_events"), []);
        assert.deepEqual(h.rows("local_reports"), []);
        assert.deepEqual(h.hubs.requests, [], "refused events must not publish a console");
      }
    });
  }
}

test("local start refuses a leave committed between admission and the D1 batch", async (t) => {
  const h = await harness(t);
  let raced = false;
  h.race.beforeBatch = () => {
    const result = h.sqlite.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .run("team_a", h.userId);
    assert.equal(result.changes, 1);
    raced = true;
  };
  const result = await h.call("POST", "/v1/local-runs", { device: true, body: {
    clientRunId: SESSION, benchmarkId: BENCHMARK, benchmarkVersion: 1,
    repositoryId: null, repositoryFullName: FIXTURE_REPO.fullName,
    sha: SHA, branch: "main", dirty: false,
  } });
  assert.equal(raced, true, "the request must reach the guarded batch");
  assert.deepEqual(result, { status: 403, body: { error: {
    code: "no_team", message: "Finish joining a team and connecting its repository first.",
  } } });
  assert.deepEqual(h.rows("team_members"), []);
  assert.deepEqual(h.rows("local_run_sessions"), []);
  assert.deepEqual(h.rows("run_surfaces"), []);
  assert.deepEqual(h.hubs.requests, []);
});

test("a linked report can be rewritten as a member but is frozen after leave", async (t) => {
  const h = await harness(t);
  const sync = (accuracy: number) => h.call("POST", "/v1/local-reports", {
    device: true, body: report("report_team_leave", accuracy),
  });
  assert.equal((await sync(0.82)).status, 201);
  await h.seedSession("report_team_leave");
  assert.equal((await sync(0.91)).status, 200);
  assert.deepEqual(JSON.parse(h.rows("local_reports")[0].metrics_json as string), report("report_team_leave", 0.91).metrics);
  assert.equal((await h.leave()).status, 200);
  const before = h.rows("local_reports");
  const sessions = h.rows("local_run_sessions");
  assert.deepEqual(await sync(0.12), { status: 403, body: { error: { code: "forbidden", message: REPORT_LEFT_TEAM } } });
  assert.deepEqual(h.rows("local_reports"), before);
  assert.deepEqual(h.rows("local_run_sessions"), sessions);
});

test("an unlinked personal report can still be created and rewritten after leave", async (t) => {
  const h = await harness(t);
  assert.equal((await h.leave()).status, 200);
  for (const [accuracy, expectedStatus] of [[0.82, 201], [0.91, 200]] as const) {
    const result = await h.call("POST", "/v1/local-reports", { device: true, body: report("report_personal", accuracy) });
    assert.equal(result.status, expectedStatus);
    const stored = h.rows("local_reports");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].user_id, h.userId);
    assert.deepEqual(JSON.parse(stored[0].metrics_json as string), report("report_personal", accuracy).metrics);
  }
  assert.deepEqual(h.rows("team_members"), []);
  assert.deepEqual(h.rows("local_run_sessions"), []);
});

test("an admitted hosted run remains unchanged and owned by team A after leave", async (t) => {
  const h = await harness(t);
  await seedHostedRun(h, "run_admitted", "queued", "practice");
  const before = h.rows("runs");
  assert.deepEqual(await h.leave(), { status: 200, body: { alreadyLeft: false } });
  assert.deepEqual(h.rows("runs"), before);
  await h.joinB();
  assert.deepEqual(h.rows("runs"), before);
  assert.equal(h.rows("runs")[0].team_id, "team_a");
});

for (const transport of ["single", "batch"] as const) {
  test(`a ${transport} event racing a leave is refused, not reported as a duplicate`, async (t) => {
    const h = await harness(t);
    await h.seedSession();
    let raced = false;
    // Admission has read the membership; the leave commits before the write.
    h.race.beforeBatch = () => {
      h.sqlite.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run("team_a", h.userId);
      raced = true;
    };
    const result = await h.call("POST", `/v1/local-runs/${SESSION}/events${transport === "batch" ? "/batch" : ""}`, {
      device: true, body: transport === "batch" ? { events: [event("progress")] } : event("progress"),
    });
    assert.equal(raced, true, "the request must reach the guarded batch");
    assert.deepEqual(result, { status: 403, body: { error: { code: "forbidden", message: LEFT_RUN_TEAM } } });
    assert.equal(h.rows("local_run_sessions")[0].last_event_sequence, 0);
    assert.deepEqual(h.rows("run_stream_events"), []);
    assert.deepEqual(h.hubs.requests, [], "a refused event must not publish the old team's console");
  });
}

test("a start racing a move to another team names that team instead of asking them to join one", async (t) => {
  const h = await harness(t);
  await h.db.insert(teams).values({
    id: "team_b", cohortId: "cohort_test", name: "Difference Engines",
    repoOwner: "synthetic", repoName: "team-b", repoFullName: "synthetic/team-b",
    repoUrl: "https://github.com/synthetic/team-b", defaultBranch: "main", discordChannelId: "channel_b",
  });
  h.race.beforeBatch = () => {
    h.sqlite.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run("team_a", h.userId);
    h.sqlite.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'write')").run("team_b", h.userId);
  };
  const result = await h.call("POST", "/v1/local-runs", { device: true, body: {
    clientRunId: SESSION, benchmarkId: BENCHMARK, benchmarkVersion: 1,
    repositoryId: null, repositoryFullName: FIXTURE_REPO.fullName,
    sha: SHA, branch: "main", dirty: false,
  } });
  assert.deepEqual(result, { status: 409, body: { error: {
    code: "forbidden",
    message: "You moved to Difference Engines while this run was starting, so the portal didn't record it. Run the command again.",
  } } });
  assert.deepEqual(h.rows("local_run_sessions"), []);
  assert.deepEqual(h.rows("run_surfaces"), []);
  assert.deepEqual(h.hubs.requests, []);
});

test("after moving to a team on the same repository, the old team's run reports stay behind", async (t) => {
  const h = await harness(t);
  const sync = (id: string) => h.call("POST", "/v1/local-reports", { device: true, body: report(id) });
  assert.equal((await sync("report_personal")).status, 201);
  assert.equal((await sync("report_team_a_run")).status, 201);
  await h.seedSession("report_team_a_run");
  // Newest for this commit, and unable to say which weights it used: if it
  // leaked into team B's weight lookup, that lookup would refuse.
  h.sqlite.prepare("UPDATE local_reports SET weights_used_known = 0, synced_at = synced_at + 10000 WHERE report_id = ?")
    .run("report_team_a_run");
  assert.equal((await h.leave()).status, 200);
  // A repository is unique per cohort, so the same repository means a new cohort.
  await h.db.insert(cohorts).values({
    id: "cohort_next", slug: "next", name: "Next cohort", joinCode: "NEXTCODE", active: true,
  });
  await h.db.insert(teams).values({
    id: "team_next", cohortId: "cohort_next", name: "Team Next",
    repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name,
    repoFullName: FIXTURE_REPO.fullName, repoUrl: FIXTURE_REPO.url,
    defaultBranch: FIXTURE_REPO.defaultBranch, repoId: FIXTURE_REPO.repositoryId,
    discordChannelId: "channel_next",
  });
  await h.db.update(users).set({ cohortId: "cohort_next" }).where(eq(users.id, h.userId));
  await h.db.insert(teamMembers).values({ teamId: "team_next", userId: h.userId, role: "write" });

  const listed = await h.call("GET", `/v1/local-reports?benchmark=${BENCHMARK}`, { cookie: h.cookie });
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body as Array<{ reportId: string }>).map((r) => r.reportId), ["report_personal"]);
  assert.deepEqual(
    await getLatestTeamWeights(h.env, "team_next", FIXTURE_REPO.fullName, SHA, FIXTURE_REPO.repositoryId, BENCHMARK, 1),
    { weightsUsed: [], weightsUploaded: null },
  );
  assert.equal(h.rows("local_run_sessions")[0].team_id, "team_a", "the run stays team A's history");
});

test("the reader's own row is marked by user id, not by the login shown", async (t) => {
  // A development account shows its email prefix, so it can read "ada"
  // beside the GitHub account ada (displayLogin in routes/team.ts).
  const h = await harness(t);
  await h.db.insert(users).values({
    id: "user_dev_ada", email: "ada@dev.local", emailVerified: true, name: "Ada (dev)", githubLogin: null,
    cohortId: "cohort_test", createdAt: new Date(NOW), updatedAt: new Date(NOW),
  });
  await h.db.insert(teamMembers).values({ teamId: "team_a", userId: "user_dev_ada", role: "write" });
  const detail = await getTeamDetail(h.db, "team_a", h.userId);
  assert.deepEqual(detail.members.map((m) => [m.login, m.isYou]).sort(), [["ada", false], ["ada", true]]);
  assert.equal(detail.members.find((m) => m.isYou)?.role, "admin", "the marked row is the caller's own membership");
});

for (const transport of ["single", "batch"] as const) {
  test(`a ${transport} completed event racing a leave saves no report, so none can follow its author`, async (t) => {
    // The report used to be saved before the guarded batch. A leave in that
    // gap left a saved report no run pointed at, which then read as personal
    // and could follow its author into another team on the same repository.
    const h = await harness(t);
    await h.seedSession();
    let raced = false;
    h.race.beforeBatch = () => {
      h.sqlite.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run("team_a", h.userId);
      raced = true;
    };
    const result = await h.call("POST", `/v1/local-runs/${SESSION}/events${transport === "batch" ? "/batch" : ""}`, {
      device: true, body: transport === "batch" ? { events: [event("completed")] } : event("completed"),
    });
    assert.equal(raced, true, "the request must reach the guarded batch");
    assert.deepEqual(result, { status: 403, body: { error: { code: "forbidden", message: LEFT_RUN_TEAM } } });
    assert.deepEqual(h.rows("local_reports"), [], "a report was saved for a run that was not recorded");
    assert.equal(h.rows("local_run_sessions")[0].status, "running");
    assert.equal(h.rows("local_run_sessions")[0].report_id, null);
    assert.deepEqual(h.rows("run_stream_events"), []);
    assert.deepEqual(h.hubs.requests, []);
  });

  test(`a ${transport} completed event from a member saves its report and links it to the run`, async (t) => {
    const h = await harness(t);
    await h.seedSession();
    const result = await h.call("POST", `/v1/local-runs/${SESSION}/events${transport === "batch" ? "/batch" : ""}`, {
      device: true, body: transport === "batch" ? { events: [event("completed")] } : event("completed"),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const [saved] = h.rows("local_reports");
    assert.equal(saved?.report_id, "report_team_leave");
    assert.equal(saved?.user_id, h.userId);
    const [session] = h.rows("local_run_sessions");
    assert.deepEqual([session.status, session.report_id], ["succeeded", "report_team_leave"]);
    assert.equal(h.rows("run_stream_events").length, 1);
  });
}
