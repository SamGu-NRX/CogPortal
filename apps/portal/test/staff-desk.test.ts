import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createAuth } from "../worker/auth/better-auth.ts";
import type { Database } from "../worker/db/client.ts";
import {
  benchmarks,
  cohorts,
  platformStaff,
  runs,
  teamMembers,
  teamProcessSignals,
  teamTas,
  teams,
  users,
} from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerStaffDeskRoutes } from "../worker/routes/staff-desk.ts";

/**
 * The staff process desk: three read routes under the admin console's
 * authorization. These tests drive the real routes through the real session
 * layer over in-memory migrations built from the same SQL files that run
 * against D1, because the properties under test are authorization decisions
 * and read projections -- a mocked guard would be a test of the mock, and a
 * mocked projection would never catch a drift from routes/team.ts's own
 * signal builders. Harness matches staff-roster.test.ts.
 *
 * The desk never talks to GitHub (that is its design: it reads what the
 * portal stored), so these tests need no GitHub mock at all. Commit history
 * reaches the routes the only way it reaches them in production: through
 * `team_process_signals` rows, in the exact format routes/team.ts stores.
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

interface Harness {
  env: Env;
  db: Database;
  signIn(githubLogin: string): Promise<string>;
  seedCohort(): Promise<void>;
  seedTeam(id: string, name: string, options?: { repoId?: number; provenance?: "live" | "archive"; fullName?: string }): Promise<void>;
  seedBenchmark(id: string, module: string): Promise<void>;
  seedRun(id: string, teamId: string, overrides?: Partial<typeof runs.$inferInsert>): Promise<void>;
  /** A stored history row, in routes/team.ts's storage format. */
  seedHistory(
    teamId: string,
    history: {
      repository: string;
      branch?: string;
      checkedAt: number;
      commits: { sha: string; authorLogin: string; authoredAt: number; filesChanged: string[]; coAuthors?: { name: string; email: string }[] }[];
    },
  ): Promise<void>;
  /** A stored row with arbitrary contents, for rows the Team page would refuse. */
  seedRawHistory(teamId: string, signalsJson: string): Promise<void>;
  call(method: string, path: string, options?: { cookie?: string }): Promise<{ status: number; body: any }>;
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
    PLATFORM_OWNER_LOGINS: OWNER,
  } as unknown as Env;
  const db = drizzle(binding as never) as unknown as Database;

  const app = new Hono<AppEnv>();
  registerStaffDeskRoutes(app);
  app.onError(handleError);

  let repoSeq = 100;
  let attemptSeq = 0;
  return {
    env,
    db,
    async signIn(githubLogin: string): Promise<string> {
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
        .set({ githubLogin })
        .where(eq(users.id, result.response.user.id));
      return result.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    },
    async seedCohort() {
      await db.insert(cohorts).values({
        id: "cohort_test",
        slug: "test",
        name: "Test cohort",
        joinCode: "TESTCODE",
        active: true,
      });
    },
    async seedTeam(id, name, options = {}) {
      const fullName = options.fullName ?? `course/${name.toLowerCase().replace(/\s+/g, "-")}`;
      await db.insert(teams).values({
        id,
        cohortId: "cohort_test",
        name,
        description: null,
        repoOwner: fullName.split("/")[0],
        repoName: fullName.split("/")[1],
        repoFullName: fullName,
        repoUrl: `https://github.com/${fullName}`,
        defaultBranch: "main",
        repoId: options.repoId ?? (repoSeq += 1),
        provenance: options.provenance ?? "live",
      });
    },
    async seedBenchmark(id, module) {
      // Some migration waves ship benchmark seeds, so this is an upsert on
      // the (id, version) key: the fixture's module always wins.
      await db
        .insert(benchmarks)
        .values({
          id,
          version: 1,
          contractVersion: "cogworks.submissions.v2",
          entryPointName: id,
          title: id,
          module,
          summary: "Test",
          active: true,
          primaryMetricKey: "accuracy",
        })
        .onConflictDoUpdate({
          target: [benchmarks.id, benchmarks.version],
          set: { module, title: id, active: true },
        });
    },
    async seedRun(id, teamId, overrides = {}) {
      await db.insert(runs).values({
        id,
        teamId,
        benchmarkId: "audio-identification",
        benchmarkVersion: 1,
        contractVersion: "cogworks.submissions.v2",
        mode: "practice",
        status: "succeeded",
        branch: "main",
        sha: "a".repeat(40),
        createdAt: 1_789_000_000_000,
        finishedAt: 1_789_000_100_000,
        provider: "fixture",
        attemptNumber: (attemptSeq += 1),
        ...overrides,
      });
    },
    async seedHistory(teamId, history) {
      await db.insert(teamProcessSignals).values({
        teamId,
        computedAt: 0,
        signalsJson: JSON.stringify({
          kind: "commit-history.v1",
          repository: history.repository,
          branch: history.branch ?? "main",
          checkedAt: history.checkedAt,
          result: {
            ok: true,
            commits: history.commits,
            truncated: false,
          },
        }),
        historyQuality: "usable",
      });
    },
    async seedRawHistory(teamId, signalsJson) {
      await db.insert(teamProcessSignals).values({ teamId, computedAt: 0, signalsJson, historyQuality: "usable" });
    },
    async call(method, path, options = {}) {
      const response = await app.fetch(
        new Request(`http://localhost:5173${path}`, {
          method,
          headers: options.cookie ? { cookie: options.cookie } : {},
        }),
        env,
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

/**
 * Two members on a team, so ownership readings have people to name. Each
 * member gets a real account through the session layer first (signIn sets
 * its github_login); a login with no account behind it is not a member.
 */
async function seedTwoMembers(h: Harness, teamId: string, logins: [string, string]) {
  const idFor = async (login: string) => {
    await h.signIn(login);
    const [row] = await h.db.select().from(users).where(eq(users.githubLogin, login));
    assert.ok(row, `account for ${login} was created`);
    return row.id;
  };
  await h.db.insert(teamMembers).values([
    { teamId, userId: await idFor(logins[0]), role: "admin" },
    { teamId, userId: await idFor(logins[1]), role: "write" },
  ]);
}

/* ── The permission matrix ─────────────────────────────────────────────── */

test("the desk refuses an unauthenticated caller on every route", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A");
  for (const path of [
    "/admin/desk/teams",
    "/admin/desk/teams/team_a",
    "/admin/desk/teams/team_a/runs",
  ]) {
    const response = await h.call("GET", path);
    assert.equal(response.status, 401, path);
    assert.equal(response.body.error.code, "unauthorized", path);
  }
});

test("a student who is nobody's TA reads no desk", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A");
  const student = await h.signIn("Morgan");
  for (const path of [
    "/admin/desk/teams",
    "/admin/desk/teams/team_a",
    "/admin/desk/teams/team_a/runs",
  ]) {
    const response = await h.call("GET", path, { cookie: student });
    assert.equal(response.status, 403, path);
    assert.equal(response.body.error.code, "forbidden", path);
  }
});

test("a TA reads their assigned team and only that team", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  await h.seedTeam("team_b", "Team B", { repoId: 102 });
  const ta = await h.signIn("Tessa");
  await h.db.insert(teamTas).values({
    teamId: "team_a",
    userId: (await h.db.select().from(users).where(eq(users.githubLogin, "Tessa")))[0].id,
    assignedAt: 1,
  });

  const list = await h.call("GET", "/admin/desk/teams", { cookie: ta });
  assert.equal(list.status, 200);
  assert.equal(list.body.scope, "ta");
  assert.deepEqual(list.body.teams.map((team: { id: string }) => team.id), ["team_a"]);

  const allowed = await h.call("GET", "/admin/desk/teams/team_a", { cookie: ta });
  assert.equal(allowed.status, 200);
  const allowedRuns = await h.call("GET", "/admin/desk/teams/team_a/runs", { cookie: ta });
  assert.equal(allowedRuns.status, 200);

  const denied = await h.call("GET", "/admin/desk/teams/team_b", { cookie: ta });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.message, "This team is not assigned to you.");
  const deniedRuns = await h.call("GET", "/admin/desk/teams/team_b/runs", { cookie: ta });
  assert.equal(deniedRuns.status, 403);
  assert.equal(deniedRuns.body.error.message, "This team is not assigned to you.");
});

test("an owner reads every live team", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  await h.seedTeam("team_b", "Team B", { repoId: 102 });
  const owner = await h.signIn(OWNER);

  const list = await h.call("GET", "/admin/desk/teams", { cookie: owner });
  assert.equal(list.status, 200);
  assert.equal(list.body.scope, "owner");
  assert.deepEqual(list.body.teams.map((team: { id: string }) => team.id), ["team_a", "team_b"]);

  assert.equal((await h.call("GET", "/admin/desk/teams/team_b", { cookie: owner })).status, 200);
  assert.equal((await h.call("GET", "/admin/desk/teams/team_b/runs", { cookie: owner })).status, 200);
});

test("a rostered staff member without an assignment reads an empty desk", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A");
  await h.db.insert(platformStaff).values({
    login: "tessa",
    displayLogin: "Tessa",
    grantedBy: OWNER,
    grantedAt: 1_780_000_000_000,
  });
  const staff = await h.signIn("Tessa");

  const list = await h.call("GET", "/admin/desk/teams", { cookie: staff });
  assert.equal(list.status, 200);
  // The same scoping the admin console applies: staff without assignments
  // see no teams, not everybody's teams.
  assert.equal(list.body.scope, "ta");
  assert.deepEqual(list.body.teams, []);
  assert.equal((await h.call("GET", "/admin/desk/teams/team_a", { cookie: staff })).status, 403);
});

test("an archive team appears on no desk", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_live", "Team Live", { repoId: 101 });
  await h.seedTeam("team_arch", "Team Archived", { repoId: 102, provenance: "archive" });
  const owner = await h.signIn(OWNER);

  const list = await h.call("GET", "/admin/desk/teams", { cookie: owner });
  assert.deepEqual(
    list.body.teams.map((team: { id: string }) => team.id),
    ["team_live"],
  );
});

test("the desk answers 404, not signals, for a team that does not exist", async () => {
  const h = harness();
  await h.seedCohort();
  const owner = await h.signIn(OWNER);
  for (const path of ["/admin/desk/teams/team_missing", "/admin/desk/teams/team_missing/runs"]) {
    const response = await h.call("GET", path, { cookie: owner });
    assert.equal(response.status, 404, path);
    assert.equal(response.body.error.code, "not_found", path);
  }
});

/* ── The read projection ───────────────────────────────────────────────── */

const CHECKED_AT = 1_789_000_500_000;

function commit(sha: string, authorLogin: string, authoredAt: number, filesChanged: string[]) {
  return { sha, authorLogin, authoredAt, filesChanged, coAuthors: [] };
}

test("the desk serves the stored history through the team page's own signal builders", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedRun("run_first", "team_a", { repositoryId: 101, status: "succeeded", finishedAt: 1_789_000_100_000 });
  // Read a minute ago, inside the Team page's 30-minute window: "fresh" is
  // measured against the clock, so a fixed past timestamp would read stale.
  const checkedAt = Date.now() - 60_000;
  await h.seedHistory("team_a", {
    repository: "course/audio",
    checkedAt,
    commits: [
      commit("1".repeat(40), "ada", checkedAt - 500, ["src/spectrogram.py"]),
      commit("2".repeat(40), "grace", checkedAt - 400, ["src/peak_finding.py"]),
      commit("3".repeat(40), "ada", checkedAt - 300, ["src/fingerprint.py", "src/query.py"]),
    ],
  });
  await seedTwoMembers(h, "team_a", ["Ada", "Grace"]);
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.scope, "owner");
  assert.equal(detail.body.team.repo.fullName, "course/audio");
  assert.equal(detail.body.commitSignals.historyQuality, "usable");
  assert.deepEqual(detail.body.commitSignals.historyWindow, { commits: 3, truncated: false });
  // The stage map came from the run's benchmark module (audio -> week1).
  assert.equal(detail.body.weekLabel, "week1");
  const spectrogram = detail.body.commitSignals.stageFootprint.spectrogram;
  assert.ok(spectrogram, "the spectrogram stage has a footprint");
  assert.ok(spectrogram.available, "a usable history reports the stage as available");
  assert.ok(spectrogram.commitCount >= 1);
  // Ownership is the stage-wide login set the team page renders -- names,
  // never per-person counts.
  assert.ok(Array.isArray(detail.body.commitSignals.ownershipBreadth.spectrogram));
  assert.ok(detail.body.commitSignals.findingSentences.length > 0);
  assert.ok(detail.body.team.tas.every((ta: { login: string }) => typeof ta.login === "string"));
  // Run-derived readings travel beside the commit-derived ones, not merged
  // into them.
  assert.deepEqual(detail.body.firstLight, {
    benchmarkId: "audio-identification",
    benchmarkTitle: "audio-identification",
    at: 1_789_000_100_000,
  });
  assert.deepEqual(detail.body.history, {
    status: "fresh",
    checkedAt,
    stale: false,
    forConnectedRepository: true,
  });
  assert.equal(detail.body.runsElsewhere, false);
});

test("a stored read older than the window is served stale, never refetched", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedHistory("team_a", {
    repository: "course/audio",
    checkedAt: CHECKED_AT - 45 * 60 * 1000,
    commits: [commit("1".repeat(40), "ada", CHECKED_AT, ["src/spectrogram.py"])],
  });
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  // The stored read is still what the desk shows -- stale is a state the
  // desk reports, not a repair it performs.
  assert.equal(detail.body.history.status, "stale");
  assert.equal(detail.body.history.checkedAt, CHECKED_AT - 45 * 60 * 1000);
  assert.equal(detail.body.history.stale, true);
  assert.ok(detail.body.commitSignals, "the stale read is still served");
});

test("a team whose history was never read is not a team without work", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedRun("run_first", "team_a", { repositoryId: 101, status: "succeeded", finishedAt: 1_789_000_100_000 });
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  // No row: the desk says the portal has not read this team's history,
  // rather than vouching for a read that never happened.
  assert.equal(detail.body.commitSignals, null);
  assert.deepEqual(detail.body.history, {
    status: "never_read",
    checkedAt: null,
    stale: false,
    forConnectedRepository: false,
  });
  // And the run-derived readings, which need no commit history, still hold:
  // a first light is recorded even though the desk cannot say anything
  // about stages yet.
  assert.deepEqual(detail.body.firstLight, {
    benchmarkId: "audio-identification",
    benchmarkTitle: "audio-identification",
    at: 1_789_000_100_000,
  });
  assert.equal(detail.body.weekLabel, "week1");
});

test("a stored read for a repository the team has left is not served against this team", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 222, fullName: "course/language" });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedRun("run_old", "team_a", { repositoryId: 111, status: "succeeded", finishedAt: 1_789_000_100_000 });
  await h.seedHistory("team_a", {
    repository: "course/week2_capstone",
    checkedAt: CHECKED_AT,
    commits: [commit("1".repeat(40), "ada", CHECKED_AT, ["src/spectrogram.py"])],
  });
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  // The read happened; it is just not about this repository.
  assert.equal(detail.body.history.status, "other_repository");
  assert.equal(detail.body.history.checkedAt, CHECKED_AT);
  assert.equal(detail.body.history.forConnectedRepository, false);
  assert.equal(detail.body.commitSignals, null);
  // The scored run belongs to the old repository too, so neither a first
  // light nor an elsewhere-flag may be quietly suppressed: the desk says
  // the scored runs are elsewhere rather than "no runs yet".
  assert.equal(detail.body.firstLight, null);
  assert.equal(detail.body.runsElsewhere, true);
});

test("a stored read of another branch is reported as such and never counts as the current branch", async () => {
  const h = harness();
  await h.seedCohort();
  // seedTeam connects branch "main"; the stored read is of "dev".
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedRun("run_first", "team_a", { repositoryId: 101, status: "succeeded", finishedAt: 1_789_000_100_000 });
  await h.seedHistory("team_a", {
    repository: "course/audio",
    branch: "dev",
    checkedAt: CHECKED_AT,
    commits: [
      commit("1".repeat(40), "ada", CHECKED_AT - 200, ["src/spectrogram.py"]),
      commit("2".repeat(40), "grace", CHECKED_AT - 100, ["src/peaks.py"]),
    ],
  });
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.history, {
    status: "other_branch",
    checkedAt: CHECKED_AT,
    stale: false,
    forConnectedRepository: false,
  });
  assert.equal(detail.body.commitSignals, null, "another branch's commits are not this branch's signals");

  const list = await h.call("GET", "/admin/desk/teams", { cookie: owner });
  assert.equal(list.body.teams[0].history.status, "other_branch");
  assert.equal(list.body.teams[0].historyQuality, null, "the stored quality describes the other branch");
});

test("a malformed stored row reads as unreadable on every desk route and never crashes", async () => {
  const rows: [string, string][] = [
    ["not JSON", "{"],
    ["JSON null", "null"],
    ["no result", JSON.stringify({ kind: "commit-history.v1", repository: "course/audio", branch: "main", checkedAt: CHECKED_AT })],
    [
      "a stored failure",
      JSON.stringify({ kind: "commit-history.v1", repository: "course/audio", branch: "main", checkedAt: CHECKED_AT, result: { ok: false, reason: "fetch_failed" } }),
    ],
    [
      "commits of the wrong shape",
      JSON.stringify({ kind: "commit-history.v1", repository: "course/audio", branch: "main", checkedAt: CHECKED_AT, result: { ok: true, commits: [{ sha: 1 }], truncated: false } }),
    ],
    [
      "no branch recorded",
      JSON.stringify({ kind: "commit-history.v1", repository: "course/audio", checkedAt: CHECKED_AT, result: { ok: true, commits: [], truncated: false } }),
    ],
    [
      "a string clock",
      JSON.stringify({ kind: "commit-history.v1", repository: "course/audio", branch: "main", checkedAt: "yesterday", result: { ok: true, commits: [], truncated: false } }),
    ],
  ];
  for (const [label, signalsJson] of rows) {
    const h = harness();
    await h.seedCohort();
    await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
    await h.seedRawHistory("team_a", signalsJson);
    const owner = await h.signIn(OWNER);

    const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
    assert.equal(detail.status, 200, label);
    assert.deepEqual(
      detail.body.history,
      { status: "unreadable", checkedAt: null, stale: false, forConnectedRepository: false },
      label,
    );
    assert.equal(detail.body.commitSignals, null, label);

    const list = await h.call("GET", "/admin/desk/teams", { cookie: owner });
    assert.equal(list.status, 200, label);
    assert.equal(list.body.teams[0].history.status, "unreadable", label);
    assert.equal(list.body.teams[0].historyQuality, null, label);
  }
});

test("a single-commit history degrades stage signals with the exact reason", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedBenchmark("audio-identification", "audio");
  // A run for the connected repository names the week (audio -> week1);
  // without one there is no stage map to degrade (see the next test).
  await h.seedRun("run_first", "team_a", { repositoryId: 101, status: "failed", finishedAt: null });
  await h.seedHistory("team_a", {
    repository: "course/audio",
    checkedAt: CHECKED_AT,
    commits: [commit("1".repeat(40), "ada", CHECKED_AT, ["src/spectrogram.py", "src/peaks.py", "everything.py"])],
  });
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.weekLabel, "week1");
  assert.equal(detail.body.commitSignals.historyQuality, "bulk_upload");
  const [spectrogram] = Object.values(detail.body.commitSignals.stageFootprint) as {
    available: boolean;
    unavailableReason: string | null;
    commitCount: number | null;
  }[];
  assert.ok(spectrogram, "week1 has stages to report");
  assert.equal(spectrogram.available, false);
  assert.equal(spectrogram.unavailableReason, "the entire history is a single commit");
  assert.equal(spectrogram.commitCount, null, "no count is invented for a degraded stage");
});

test("with no run to name the week, the stage map is unknowable and the window still reads", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedHistory("team_a", {
    repository: "course/audio",
    checkedAt: CHECKED_AT,
    commits: [
      commit("1".repeat(40), "ada", CHECKED_AT - 200, ["src/spectrogram.py"]),
      commit("2".repeat(40), "grace", CHECKED_AT - 100, ["src/peaks.py"]),
    ],
  });
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.weekLabel, null);
  assert.equal(detail.body.firstLight, null);
  // Usable history, no stage map: the desk still reports what it read.
  assert.deepEqual(detail.body.commitSignals.historyWindow, { commits: 2, truncated: false });
  assert.deepEqual(detail.body.commitSignals.stageFootprint, {});
  assert.ok(detail.body.commitSignals.findingSentences.length > 0);
});

test("the desk list reads stored state: quality, freshness, week and first light", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedTeam("team_b", "Team B", { repoId: 102, fullName: "course/language" });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedRun("run_a", "team_a", { repositoryId: 101, status: "succeeded", finishedAt: 1_789_000_100_000 });
  // Team B scored twice against a repository it has since left: the count
  // stands only for the connected repository, so it reads zero-with-a-flag,
  // never a blended total.
  await h.seedRun("run_b1", "team_b", { repositoryId: 999, status: "succeeded", finishedAt: 1_789_000_200_000 });
  await h.seedRun("run_b2", "team_b", { repositoryId: 999, status: "succeeded", finishedAt: 1_789_000_300_000 });
  await h.seedHistory("team_a", {
    repository: "course/audio",
    checkedAt: CHECKED_AT - 45 * 60 * 1000,
    commits: [
      commit("1".repeat(40), "ada", CHECKED_AT, ["src/spectrogram.py"]),
      commit("2".repeat(40), "grace", CHECKED_AT, ["src/peaks.py"]),
    ],
  });
  const owner = await h.signIn(OWNER);

  const list = await h.call("GET", "/admin/desk/teams", { cookie: owner });
  assert.equal(list.status, 200);
  const [a, b] = list.body.teams;
  assert.equal(a.historyQuality, "usable");
  assert.deepEqual(a.history, {
    status: "stale",
    checkedAt: CHECKED_AT - 45 * 60 * 1000,
    stale: true,
    forConnectedRepository: true,
  });
  assert.equal(a.weekLabel, "week1");
  assert.deepEqual(a.firstLight, {
    benchmarkId: "audio-identification",
    benchmarkTitle: "audio-identification",
    at: 1_789_000_100_000,
  });
  assert.equal(a.scoredRunCount, 1);

  assert.equal(b.historyQuality, null);
  assert.equal(b.history.status, "never_read");
  assert.equal(b.history.checkedAt, null);
  assert.equal(b.scoredRunCount, 0, "a run from another repository is not this repository's count");
});

/* ── No per-person totals, in any response, anywhere ──────────────────── */

// Mirrors process-signals.test.ts's guardrail, moved one layer out: the
// desk routes' serialized output, walked recursively. distinctAuthorCount
// is the same stage-wide exception the team page already carries.
const FORBIDDEN_KEY_SUBSTRINGS = [
  "byauthor",
  "perauthor",
  "authorcommit",
  "commitsby",
  "authorcount",
  "lines",
  "linecount",
  "insertions",
  "deletions",
];
const ALLOWED_KEY_EXCEPTIONS = new Set(["distinctAuthorCount"]);

function collectKeys(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
}

test("no desk response key, anywhere in the tree, is a per-person total or a line count", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedRun("run_a", "team_a", { repositoryId: 101, status: "succeeded", finishedAt: 1_789_000_100_000 });
  await h.seedHistory("team_a", {
    repository: "course/audio",
    checkedAt: CHECKED_AT,
    commits: [
      commit("1".repeat(40), "ada", CHECKED_AT - 200, ["src/spectrogram.py"]),
      commit("2".repeat(40), "grace", CHECKED_AT - 100, ["src/peaks.py"]),
    ],
  });
  await seedTwoMembers(h, "team_a", ["Ada", "Grace"]);
  const owner = await h.signIn(OWNER);

  const detail = await h.call("GET", "/admin/desk/teams/team_a", { cookie: owner });
  const list = await h.call("GET", "/admin/desk/teams", { cookie: owner });
  const runList = await h.call("GET", "/admin/desk/teams/team_a/runs", { cookie: owner });
  for (const [name, response] of [
    ["detail", detail],
    ["list", list],
    ["runs", runList],
  ] as const) {
    const keys: string[] = [];
    collectKeys(response.body, keys);
    const violations = keys.filter(
      (key) =>
        !ALLOWED_KEY_EXCEPTIONS.has(key)
        && FORBIDDEN_KEY_SUBSTRINGS.some((needle) => key.toLowerCase().includes(needle)),
    );
    assert.deepEqual(violations, [], `${name} carries a forbidden key`);
  }
});

/* ── The run drill-down ────────────────────────────────────────────────── */

test("the run list paginates newest first and reports the window", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  for (let i = 0; i < 25; i += 1) {
    await h.seedRun(`run_${String(i).padStart(2, "0")}`, "team_a", {
      repositoryId: 101,
      status: i % 3 === 0 ? "failed" : "succeeded",
      createdAt: 1_789_000_000_000 + i * 1_000,
      finishedAt: i % 3 === 0 ? null : 1_789_000_100_000 + i,
      failurePhase: i % 3 === 0 ? ("evaluating" as const) : null,
      failureCategory: i % 3 === 0 ? ("student_runtime" as const) : null,
    });
  }
  const owner = await h.signIn(OWNER);

  const first = await h.call("GET", "/admin/desk/teams/team_a/runs", { cookie: owner });
  assert.equal(first.status, 200);
  assert.equal(first.body.page, 1);
  assert.equal(first.body.pageSize, 20);
  assert.equal(first.body.total, 25);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.runs.length, 20);
  assert.equal(first.body.runs[0].runId, "run_24", "newest first");

  const second = await h.call("GET", "/admin/desk/teams/team_a/runs?page=2", { cookie: owner });
  assert.equal(second.body.runs.length, 5);
  assert.equal(second.body.hasMore, false);

  const tight = await h.call("GET", "/admin/desk/teams/team_a/runs?page=3&pageSize=10", { cookie: owner });
  assert.equal(tight.body.runs.length, 5);
  assert.equal(tight.body.page, 3);
});

test("the run list filters by status group and single status", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  // The schema allows at most one active run per team+benchmark, so the two
  // active runs sit on different benchmarks.
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedBenchmark("audio-identification-b", "audio");
  await h.seedRun("run_active", "team_a", { repositoryId: 101, status: "evaluating", finishedAt: null, benchmarkId: "audio-identification" });
  await h.seedRun("run_queued", "team_a", { repositoryId: 101, status: "queued", finishedAt: null, benchmarkId: "audio-identification-b" });
  await h.seedRun("run_done", "team_a", { repositoryId: 101, status: "succeeded" });
  await h.seedRun("run_dead", "team_a", { repositoryId: 101, status: "failed", finishedAt: null });
  const owner = await h.signIn(OWNER);

  const active = await h.call("GET", "/admin/desk/teams/team_a/runs?status=active", { cookie: owner });
  assert.deepEqual(
    active.body.runs.map((run: { runId: string }) => run.runId).sort(),
    ["run_active", "run_queued"],
  );
  const terminal = await h.call("GET", "/admin/desk/teams/team_a/runs?status=terminal", { cookie: owner });
  assert.deepEqual(
    terminal.body.runs.map((run: { runId: string }) => run.runId).sort(),
    ["run_dead", "run_done"],
  );
  const failed = await h.call("GET", "/admin/desk/teams/team_a/runs?status=failed", { cookie: owner });
  assert.deepEqual(failed.body.runs.map((run: { runId: string }) => run.runId), ["run_dead"]);
  assert.equal(failed.body.total, 1);
});

test("the runner-activity clock on the desk mirrors the maintenance sweep", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  // One active run per team+benchmark: each live run sits on its own
  // benchmark so the seeds are legal.
  await h.seedBenchmark("audio-identification", "audio");
  await h.seedBenchmark("audio-identification-b", "audio");
  await h.seedBenchmark("audio-identification-c", "audio");
  const now = Date.now();
  // Silent for two hours: the sweep would fail this run, so the desk calls
  // it stale rather than "in progress".
  await h.seedRun("run_silent", "team_a", {
    repositoryId: 101,
    status: "evaluating",
    finishedAt: null,
    benchmarkId: "audio-identification",
    acceptedActivityAt: now - 2 * 60 * 60 * 1000,
  });
  await h.seedRun("run_busy", "team_a", {
    repositoryId: 101,
    status: "evaluating",
    finishedAt: null,
    benchmarkId: "audio-identification-b",
    acceptedActivityAt: now - 5 * 60 * 1000,
  });
  // A row from before the activity clock: inside its one-time grace it is
  // not stale yet, whatever its creation time says.
  await h.seedRun("run_legacy", "team_a", {
    repositoryId: 101,
    status: "scoring",
    finishedAt: null,
    benchmarkId: "audio-identification-c",
    createdAt: now - 3 * 60 * 60 * 1000,
    legacyGraceUntil: now + 30 * 60 * 1000,
  });
  await h.seedRun("run_done", "team_a", { repositoryId: 101, status: "succeeded" });
  const owner = await h.signIn(OWNER);

  const runs = await h.call("GET", "/admin/desk/teams/team_a/runs", { cookie: owner });
  const activity = new Map(
    runs.body.runs.map((run: { runId: string; activity: string }) => [run.runId, run.activity]),
  );
  assert.equal(activity.get("run_silent"), "stale");
  assert.equal(activity.get("run_busy"), "active");
  assert.equal(activity.get("run_legacy"), "active");
  assert.equal(activity.get("run_done"), "terminal");
});

test("run rows say which repository they stand for, including 'nobody recorded one'", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101, fullName: "course/audio" });
  await h.seedRun("run_connected", "team_a", { repositoryId: 101, repositoryFullName: "course/audio" });
  await h.seedRun("run_elsewhere", "team_a", { repositoryId: 999, repositoryFullName: "course/week2_capstone" });
  await h.seedRun("run_unrecorded", "team_a", { repositoryId: null, repositoryFullName: null });
  const owner = await h.signIn(OWNER);

  const runs = await h.call("GET", "/admin/desk/teams/team_a/runs", { cookie: owner });
  const byId = new Map(runs.body.runs.map((run: { runId: string }) => [run.runId, run]));
  assert.equal(byId.get("run_connected").evidence, "connected");
  assert.equal(byId.get("run_connected").repositoryFullName, "course/audio");
  assert.equal(byId.get("run_elsewhere").evidence, "elsewhere");
  assert.equal(byId.get("run_elsewhere").repositoryFullName, "course/week2_capstone");
  assert.equal(byId.get("run_unrecorded").evidence, "unrecorded");
  assert.equal(
    byId.get("run_unrecorded").repositoryFullName,
    null,
    "a pre-0013 run's source is unknown, not filled in from the team",
  );
});

test("run rows carry failure enums and never a run's text", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  await h.seedRun("run_dead", "team_a", {
    repositoryId: 101,
    status: "failed",
    finishedAt: null,
    failurePhase: "installing",
    failureCategory: "dependency_install",
    failureDetail: "module 'torch' has no attribute 'load'",
    log: "a lot of the team's own exception text",
    diagnosticsJson: '["scorer notes that hold their own words"]',
    refusalJson: '{"reason":"nothing found to score"}',
  });
  const owner = await h.signIn(OWNER);

  const runs = await h.call("GET", "/admin/desk/teams/team_a/runs", { cookie: owner });
  assert.equal(runs.status, 200);
  const [row] = runs.body.runs;
  assert.deepEqual(row.failurePhase, "installing");
  assert.deepEqual(row.failureCategory, "dependency_install");
  for (const forbidden of ["failureDetail", "log", "diagnosticsJson", "refusalJson", "sweepJson", "wiringJson"]) {
    assert.equal(row[forbidden], undefined, `${forbidden} never reaches the desk`);
  }
  // The prepared-snapshot provenance is presence and a digest, not contents.
  assert.deepEqual(row.preparedSnapshot, { recorded: false, environmentDigest: null });
});

test("the run list refuses malformed query parameters", async () => {
  const h = harness();
  await h.seedCohort();
  await h.seedTeam("team_a", "Team A", { repoId: 101 });
  const owner = await h.signIn(OWNER);
  for (const query of ["?page=0", "?pageSize=99", "?status=soon", "?mode=sometimes"]) {
    const response = await h.call("GET", `/admin/desk/teams/team_a/runs${query}`, { cookie: owner });
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error.code, "invalid_request", query);
  }
});
