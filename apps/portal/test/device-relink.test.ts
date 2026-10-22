import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Database } from "../worker/db/client.ts";
import { cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerConnectionRoutes } from "../worker/routes/connections.ts";

/**
 * A link under a name this account already has live must retire the token
 * the earlier link issued. The token route used to insert a new device row
 * and leave the old one live, so every re-link added a 60-day token that
 * nothing revoked.
 *
 * Approval is a signed-in browser request; these tests write the approval
 * directly, the way /v1/cli/device/approve does, and drive start, token and
 * status through the routes.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

interface Faults {
  /** Fail the next insert into cli_devices, as a D1 error would. */
  failDeviceInsert: boolean;
}

function freshDb(faults: Faults): { db: Database; binding: unknown; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const injected = (query: string) => {
    if (!faults.failDeviceInsert || !/^insert into "cli_devices"/i.test(query)) return;
    faults.failDeviceInsert = false;
    throw new Error("D1_ERROR: injected device insert failure");
  };
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
          injected(query);
          return { success: true, meta: statement.run(...bound) };
        },
        /** One statement of a batch, run synchronously inside its transaction. */
        execute() {
          injected(query);
          const results = statement.all(...bound);
          const { changes } = sqlite.prepare("SELECT changes() AS changes").get()!;
          return { success: true, results, meta: { changes } };
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
    // D1 commits a batch as one transaction; mirror that so a failure inside
    // one rolls back what the batch wrote before it.
    async batch(statements: Array<{ execute(): unknown }>) {
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
  // SAFETY: this shim implements the prepared-statement methods used here;
  // Cloudflare's D1 type also requires host methods these tests never call.
  return { db: drizzle(binding as never), binding, sqlite };
}

async function seed(db: Database): Promise<void> {
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values([
    { id: "user_1", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort_1" },
    { id: "user_2", name: "Bea", email: "bea@example.test", githubLogin: "bea", cohortId: "cohort_1" },
  ]);
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Team", description: null,
    repoOwner: "example", repoName: "capstone", repoFullName: "example/capstone",
    repoUrl: "https://github.com/example/capstone", defaultBranch: "main", repoId: 1,
  });
  await db.insert(teamMembers).values([
    { teamId: "team_1", userId: "user_1", role: "admin" },
    { teamId: "team_1", userId: "user_2", role: "member" },
  ]);
}

async function setup() {
  const faults: Faults = { failDeviceInsert: false };
  const { db, binding, sqlite } = freshDb(faults);
  await seed(db);
  // SAFETY: the connection routes touch only DB and PUBLIC_ORIGIN here.
  const env = {
    DB: binding, ENVIRONMENT: "development", DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "fixture", PUBLIC_ORIGIN: "https://portal.example",
  } as Env;
  const app = new Hono<AppEnv>();
  registerConnectionRoutes(app);
  app.onError(handleError);
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init), env);

  /** Starts a device link, approves it for `userId` as `name`, and returns the poll's answer. */
  const poll = async (userId: string, name: string) => {
    const started = await call("/v1/cli/device/start", { method: "POST" });
    assert.equal(started.status, 200);
    const { deviceCode, userCode } = (await started.json()) as { deviceCode: string; userCode: string };
    sqlite
      .prepare("UPDATE device_authorizations SET user_id = ?, device_name = ?, approved_at = ? WHERE user_code = ?")
      .run(userId, name, Date.now(), userCode);
    const poll = () => call("/v1/cli/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    return { response: await poll(), again: poll };
  };
  const link = async (userId: string, name: string) => {
    const { response } = await poll(userId, name);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; token: string };
    assert.equal(body.status, "authorized");
    return body.token;
  };
  const status = (token: string) =>
    call("/v1/cli/device/status", { headers: { Authorization: `Bearer ${token}` } });
  const live = (userId: string) =>
    sqlite
      .prepare("SELECT name FROM cli_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at, name")
      .all(userId)
      .map((row) => row.name);
  return { faults, link, poll, status, live };
}

test("linking twice under one name refuses the first token and accepts the second", async () => {
  const portal = await setup();
  const first = await portal.link("user_1", "Lab laptop");
  assert.equal((await portal.status(first)).status, 200, "the first link works before the second");

  const second = await portal.link("user_1", "Lab laptop");
  assert.equal((await portal.status(first)).status, 401, "the replaced token is refused");
  assert.equal((await portal.status(second)).status, 200, "the new token works");
  assert.deepEqual(portal.live("user_1"), ["Lab laptop"], "one live device per name");
});

test("a re-link leaves other names and other accounts' devices live", async () => {
  const portal = await setup();
  const desk = await portal.link("user_1", "Desk tower");
  const theirs = await portal.link("user_2", "Lab laptop");
  await portal.link("user_1", "Lab laptop");
  await portal.link("user_1", "Lab laptop");

  assert.equal((await portal.status(desk)).status, 200, "a different name stays linked");
  assert.equal((await portal.status(theirs)).status, 200, "another account's same-named device stays linked");
  assert.deepEqual(portal.live("user_1"), ["Desk tower", "Lab laptop"]);
});

test("a re-link whose device insert fails keeps the old token and lets the next poll finish", async () => {
  const portal = await setup();
  const first = await portal.link("user_1", "Lab laptop");

  portal.faults.failDeviceInsert = true;
  const { response, again } = await portal.poll("user_1", "Lab laptop");
  assert.equal(response.status, 500);
  assert.equal((await portal.status(first)).status, 200, "the revoke rolled back with the failed insert");

  const retried = await again();
  assert.equal(retried.status, 200, "the released claim lets the CLI's next poll link");
  const { token } = (await retried.json()) as { token: string };
  assert.equal((await portal.status(first)).status, 401);
  assert.equal((await portal.status(token)).status, 200);
});
