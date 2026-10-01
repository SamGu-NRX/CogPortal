/**
 * Team settings follow GitHub admin permission. Stored roles can go stale,
 * so reads and settings actions must re-check them without promoting anyone
 * when GitHub cannot answer.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { createAuth } from "../worker/auth/better-auth.ts";
import type { Database } from "../worker/db/client.ts";
import { accounts, cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerGithubRoutes } from "../worker/routes/github.ts";
import { registerTeamRoutes } from "../worker/routes/team.ts";
import { registerTeamMembershipRoutes } from "../worker/routes/team-membership.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const CURRENT_REPO = "course/current";
const DESTINATION_REPO = "course/destination";
type Role = "write" | "maintain" | "admin";
type Person = { login: string; userId: string; cookie: string; token: string };
type ApiBody = {
  isAdmin?: boolean;
  name?: string;
  team?: { id: string };
  error?: { code: string; message: string };
};
type Result = { status: number; body: ApiBody };

function freshBinding(t: TestContext): unknown {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
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
      execute() {
        const results = statement.all(...bound);
        const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
        return { success: true, results, meta: { changes } };
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
  return {
    prepare,
    // D1 commits a batch as one transaction; the repository switch relies on it.
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

async function harness(t: TestContext, configured = true) {
  const binding = freshBinding(t);
  const env = {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
    ...(configured ? { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret" } : {}),
  } as unknown as Env;
  const db = drizzle(binding as never) as unknown as Database;
  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true,
  });
  const app = new Hono<AppEnv>();
  registerGithubRoutes(app);
  registerTeamRoutes(app);
  registerTeamMembershipRoutes(app);
  app.onError(handleError);

  return {
    db,
    async signIn(login: string): Promise<Person> {
      // Dev email sign-up is disabled when GitHub is configured. Create the
      // session locally, then use it with configured GitHub route bindings.
      const signupEnv = { ...env, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined };
      const result = await createAuth(signupEnv).api.signUpEmail({
        body: {
          email: `${login.toLowerCase()}@users.noreply.github.com`,
          password: "cogportal-local-dev-password",
          name: login,
        },
        returnHeaders: true,
      });
      const userId = result.response.user.id;
      await db.update(users).set({ githubLogin: login, cohortId: "cohort_test" }).where(eq(users.id, userId));
      const token = `token-${login}`;
      if (configured) {
        await db.insert(accounts).values({
          id: `github_${login}`, accountId: `github_${login}`, providerId: "github", userId,
          accessToken: await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET!, data: token }),
        });
      }
      return {
        login, userId, token,
        cookie: result.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "),
      };
    },
    async call(person: Person, method: string, path: string, body?: unknown): Promise<Result> {
      const response = await app.fetch(new Request(`http://localhost:5173${path}`, {
        method,
        headers: { cookie: person.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }), env);
      return { status: response.status, body: await response.json() as ApiBody };
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function mockGithub(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const permissions = new Map<string, string | 500 | "network-error">();
  const logins = new Map<string, string>();
  const unexpected: string[] = [];
  let beforeContents: ((repo: string) => Promise<void>) | undefined;
  let beforePermission: ((login: string, repo: string) => Promise<void>) | undefined;
  const requests: string[] = [];
  const key = (token: string, repo: string) => `${token}:${repo}`;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
    requests.push(`${request.method} ${url.href} ${token}`);
    const match = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(url.pathname);
    if (request.method !== "GET" || url.origin !== "https://api.github.com" || url.search || !match || !logins.has(token)) {
      unexpected.push(requests.at(-1)!);
      assert.fail(`Unexpected GitHub request: ${requests.at(-1)}`);
    }
    const [, owner, name, suffix] = match;
    const repo = `${owner}/${name}`;
    if (!permissions.has(key(token, repo))) {
      unexpected.push(requests.at(-1)!);
      assert.fail(`No permission configured for ${token} on ${repo}`);
    }
    if (suffix === "") {
      return Response.json({
        id: repo === CURRENT_REPO ? 101 : 202,
        private: false, fork: false, description: "Repository description", pushed_at: null,
        html_url: `https://github.com/${repo}`, default_branch: "main",
        owner: { login: owner, type: "Organization" }, name,
        parent: null, source: null,
      });
    }
    if (suffix === `/collaborators/${encodeURIComponent(logins.get(token)!)}/permission`) {
      await beforePermission?.(logins.get(token)!, repo);
      const permission = permissions.get(key(token, repo))!;
      if (permission === 500) return new Response(null, { status: 500 });
      if (permission === "network-error") throw new TypeError("GitHub network unavailable");
      return Response.json({ permission, role_name: permission });
    }
    if (suffix === "/contents/cogportal.toml") {
      await beforeContents?.(repo);
      return new Response(null, { status: 404 });
    }
    unexpected.push(requests.at(-1)!);
    assert.fail(`Unexpected GitHub request: ${requests.at(-1)}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    // Reconciliation catches provider errors, including a mock assertion.
    assert.deepEqual(unexpected, [], "no unexpected GitHub requests were swallowed");
  });
  return {
    requests,
    set(person: Person, repo: string, permission: string | 500 | "network-error") {
      logins.set(person.token, person.login);
      permissions.set(key(person.token, repo), permission);
    },
    holdContents(callback: (repo: string) => Promise<void>) { beforeContents = callback; },
    holdPermission(callback: (login: string, repo: string) => Promise<void>) { beforePermission = callback; },
  };
}

async function seedTeam(h: Harness, person: Person, role: Role) {
  await h.db.insert(teams).values({
    id: "team_test", cohortId: "cohort_test", name: "Original team", description: "Original description",
    repoOwner: "course", repoName: "current", repoFullName: CURRENT_REPO,
    repoUrl: `https://github.com/${CURRENT_REPO}`, defaultBranch: "main", repoId: 101,
  });
  await h.db.insert(teamMembers).values({ teamId: "team_test", userId: person.userId, role });
}

async function membership(h: Harness, person: Person) {
  const rows = await h.db.select().from(teamMembers).where(eq(teamMembers.userId, person.userId));
  assert.equal(rows.length, 1, `${person.login} has exactly one membership`);
  return rows[0];
}

async function onlyTeam(h: Harness) {
  const rows = await h.db.select().from(teams);
  assert.equal(rows.length, 1, "exactly one team row exists");
  return rows[0];
}

function forbidden(result: Result) {
  assert.equal(result.status, 403);
  assert.equal(result.body.error?.code, "forbidden");
}

function adminDetail(result: Result, expected: boolean) {
  assert.equal(result.status, 200);
  assert.equal(result.body.isAdmin, expected);
}

test("a write collaborator creates a write membership without team settings access", async (t) => {
  const h = await harness(t);
  const github = mockGithub(t);
  const person = await h.signIn("Ada");
  github.set(person, CURRENT_REPO, "write");
  const connected = await h.call(person, "POST", "/github/connect", { fullName: CURRENT_REPO, teamName: "Write team" });
  assert.equal(connected.status, 200);
  const team = await onlyTeam(h);
  assert.equal(team.repoFullName, CURRENT_REPO);
  assert.equal(team.name, "Write team");
  assert.equal(connected.body.team?.id, team.id);
  assert.equal((await membership(h, person)).role, "write");
  adminDetail(await h.call(person, "GET", "/team"), false);
  forbidden(await h.call(person, "PATCH", "/team", { name: "Not allowed" }));
  assert.equal((await membership(h, person)).role, "write");
  assert.deepEqual(await onlyTeam(h), team);
});

test("concurrent creators keep their own GitHub roles on one shared team", async (t) => {
  const h = await harness(t);
  const github = mockGithub(t);
  const writer = await h.signIn("Ada");
  const admin = await h.signIn("Grace");
  github.set(writer, CURRENT_REPO, "write");
  github.set(admin, CURRENT_REPO, "admin");
  let arrivals = 0;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const timer = setTimeout(() => reject(new Error("Both connect requests must reach GitHub before creating a team")), 5_000);
  t.after(() => clearTimeout(timer));
  github.holdContents(async (repo) => {
    assert.equal(repo, CURRENT_REPO);
    arrivals += 1;
    if (arrivals === 2) { clearTimeout(timer); release(); }
    await barrier;
  });
  const results = await Promise.all([writer, admin].map((person) =>
    h.call(person, "POST", "/github/connect", { fullName: CURRENT_REPO, teamName: `${person.login}'s team` }),
  ));
  assert.equal(arrivals, 2);
  const team = await onlyTeam(h);
  assert.equal(team.repoFullName, CURRENT_REPO);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.team?.id, team.id);
  }
  assert.equal((await h.db.select().from(teamMembers)).length, 2);
  for (const [person, role] of [[writer, "write"], [admin, "admin"]] as const) {
    const row = await membership(h, person);
    assert.equal(row.teamId, team.id);
    assert.equal(row.role, role);
  }
});

test("an added provisional writer regains GitHub admin controls on the next team read", async (t) => {
  const h = await harness(t);
  const github = mockGithub(t);
  const admin = await h.signIn("Ada");
  const added = await h.signIn("Grace");
  await seedTeam(h, admin, "admin");
  github.set(admin, CURRENT_REPO, "admin");
  github.set(added, CURRENT_REPO, "write");
  adminDetail(await h.call(admin, "POST", "/team/members", { login: added.login }), true);
  assert.equal((await membership(h, added)).role, "write");
  github.set(added, CURRENT_REPO, "admin");
  adminDetail(await h.call(added, "GET", "/team"), true);
  assert.equal((await membership(h, added)).role, "admin");
  const updated = await h.call(added, "PATCH", "/team", { name: "Renamed by Grace" });
  adminDetail(updated, true);
  assert.equal(updated.body.name, "Renamed by Grace");
  assert.equal((await onlyTeam(h)).name, "Renamed by Grace");
});

test("a GitHub demotion refuses settings changes and removes stale admin controls", async (t) => {
  const h = await harness(t);
  const github = mockGithub(t);
  const person = await h.signIn("Ada");
  await seedTeam(h, person, "admin");
  github.set(person, CURRENT_REPO, "admin");
  adminDetail(await h.call(person, "GET", "/team"), true);
  const before = await onlyTeam(h);
  github.set(person, CURRENT_REPO, "write");
  forbidden(await h.call(person, "PATCH", "/team", { name: "Refused name", description: "Refused description" }));
  assert.deepEqual(await onlyTeam(h), before);
  assert.equal((await membership(h, person)).role, "write");
  adminDetail(await h.call(person, "GET", "/team"), false);
  assert.equal((await membership(h, person)).role, "write");
});

test("a stored writer verified as GitHub admin can change settings without a prior read", async (t) => {
  const h = await harness(t);
  const github = mockGithub(t);
  const person = await h.signIn("Ada");
  await seedTeam(h, person, "write");
  github.set(person, CURRENT_REPO, "admin");
  const updated = await h.call(person, "PATCH", "/team", { name: "Promoted admin's team" });
  adminDetail(updated, true);
  assert.equal(updated.body.name, "Promoted admin's team");
  assert.equal((await membership(h, person)).role, "admin");
  assert.equal((await onlyTeam(h)).name, "Promoted admin's team");
});

test("repository changes require destination admin and reset other members to write", async (t) => {
  const h = await harness(t);
  const github = mockGithub(t);
  const actor = await h.signIn("Ada");
  const other = await h.signIn("Grace");
  await seedTeam(h, actor, "admin");
  await h.db.insert(teamMembers).values({ teamId: "team_test", userId: other.userId, role: "admin" });
  github.set(actor, CURRENT_REPO, "admin");
  github.set(actor, DESTINATION_REPO, "write");
  const before = await onlyTeam(h);
  forbidden(await h.call(actor, "POST", "/team/repository", { fullName: DESTINATION_REPO }));
  assert.deepEqual(await onlyTeam(h), before);
  assert.equal((await membership(h, actor)).role, "admin");
  assert.equal((await membership(h, other)).role, "admin");
  github.set(actor, DESTINATION_REPO, "admin");
  adminDetail(await h.call(actor, "POST", "/team/repository", { fullName: DESTINATION_REPO }), true);
  const after = await onlyTeam(h);
  assert.equal(after.repoFullName, DESTINATION_REPO);
  assert.equal(after.repoOwner, "course");
  assert.equal(after.repoName, "destination");
  assert.equal(after.repoUrl, `https://github.com/${DESTINATION_REPO}`);
  assert.equal(after.repoId, 202);
  assert.equal(after.defaultBranch, "main");
  assert.equal((await membership(h, actor)).role, "admin");
  assert.equal((await membership(h, other)).role, "write");
});

for (const before of ["write", "admin"] as const) {
  test(`an answer about the previous repository neither lands nor passes after a switch (stored ${before})`, async (t) => {
    // A teammate's check of the old repository can still be in flight when an
    // admin moves the team. Acted on afterwards, it would let them change
    // settings, or store them as admin, for a repository GitHub was never
    // asked about, whatever their role before the switch.
    const h = await harness(t);
    const github = mockGithub(t);
    const actor = await h.signIn("Ada");
    const teammate = await h.signIn("Grace");
    await seedTeam(h, actor, "admin");
    await h.db.insert(teamMembers).values({ teamId: "team_test", userId: teammate.userId, role: before });
    github.set(actor, CURRENT_REPO, "admin");
    github.set(actor, DESTINATION_REPO, "admin");
    github.set(teammate, CURRENT_REPO, "admin");
    let arrived!: () => void;
    const teammateAsked = new Promise<void>((resolve) => { arrived = resolve; });
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    github.holdPermission(async (login) => {
      if (login !== teammate.login) return;
      arrived();
      await answered;
    });

    const pending = h.call(teammate, "PATCH", "/team", { name: "Stale admin's name" });
    await teammateAsked;
    adminDetail(await h.call(actor, "POST", "/team/repository", { fullName: DESTINATION_REPO }), true);
    answer();
    forbidden(await pending);
    assert.equal((await membership(h, teammate)).role, "write");
    const team = await onlyTeam(h);
    assert.equal(team.repoFullName, DESTINATION_REPO);
    assert.equal(team.name, "Original team");
  });
}

for (const failure of [500, "network-error"] as const) {
  test(`a permission lookup failure (${failure}) preserves roles and the stored-admin outage fallback`, async (t) => {
    const h = await harness(t);
    const github = mockGithub(t);
    const writer = await h.signIn("Ada");
    const admin = await h.signIn("Grace");
    await seedTeam(h, writer, "write");
    await h.db.insert(teamMembers).values({ teamId: "team_test", userId: admin.userId, role: "admin" });
    github.set(writer, CURRENT_REPO, failure);
    github.set(admin, CURRENT_REPO, failure);
    const before = await onlyTeam(h);
    adminDetail(await h.call(writer, "GET", "/team"), false);
    assert.equal((await membership(h, writer)).role, "write");
    forbidden(await h.call(writer, "PATCH", "/team", { name: "Refused name" }));
    assert.equal((await membership(h, writer)).role, "write");
    assert.deepEqual(await onlyTeam(h), before);
    adminDetail(await h.call(admin, "GET", "/team"), true);
    const updated = await h.call(admin, "PATCH", "/team", { name: "Outage fallback" });
    adminDetail(updated, true);
    assert.equal(updated.body.name, "Outage fallback");
    assert.equal((await onlyTeam(h)).name, "Outage fallback");
    assert.equal((await membership(h, admin)).role, "admin");
  });
}

for (const permission of ["maintain", "read", "none"] as const) {
  test(`all settings gates reconcile a stale admin with GitHub ${permission} permission`, async (t) => {
    const h = await harness(t);
    const github = mockGithub(t);
    const person = await h.signIn("Ada");
    const target = await h.signIn("Grace");
    await seedTeam(h, person, "admin");
    github.set(person, CURRENT_REPO, permission);
    const before = await onlyTeam(h);
    const actions = [
      ["PATCH", "/team", { name: "Refused name" }],
      ["POST", "/team/repository", { fullName: DESTINATION_REPO }],
      ["GET", "/team/invitable", undefined],
      ["POST", "/team/members", { login: target.login }],
      ["DELETE", `/team/members/${target.login}`, undefined],
    ] as const;
    for (const [method, path, body] of actions) {
      await h.db.update(teamMembers).set({ role: "admin" }).where(eq(teamMembers.userId, person.userId));
      const callsBefore = github.requests.length;
      forbidden(await h.call(person, method, path, body));
      assert.equal(github.requests.length, callsBefore + 1, `${method} ${path} re-checks GitHub`);
      assert.equal((await membership(h, person)).role, permission === "maintain" ? "maintain" : "write");
      assert.deepEqual(await onlyTeam(h), before);
      assert.equal((await h.db.select().from(teamMembers)).length, 1);
    }
  });
}

test("the unconfigured local fixture keeps creator admin without any GitHub fetch", async (t) => {
  const h = await harness(t, false);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(input instanceof Request ? input.url : String(input));
    assert.fail("The local fixture must not call GitHub");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    assert.deepEqual(requests, []);
  });
  const person = await h.signIn("Ada");
  const connected = await h.call(person, "POST", "/github/connect", { fullName: FIXTURE_REPO.fullName, teamName: "Fixture team" });
  assert.equal(connected.status, 200);
  const team = await onlyTeam(h);
  assert.equal(team.repoFullName, FIXTURE_REPO.fullName);
  assert.equal(connected.body.team?.id, team.id);
  assert.equal((await membership(h, person)).role, "admin");
  adminDetail(await h.call(person, "GET", "/team"), true);
  const updated = await h.call(person, "PATCH", "/team", { name: "Renamed fixture" });
  adminDetail(updated, true);
  assert.equal(updated.body.name, "Renamed fixture");
  assert.equal((await onlyTeam(h)).name, "Renamed fixture");
  assert.equal((await membership(h, person)).role, "admin");
  assert.deepEqual(requests, []);
});
