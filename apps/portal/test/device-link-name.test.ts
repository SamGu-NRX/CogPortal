import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Database } from "../worker/db/client.ts";
import { cohorts, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerConnectionRoutes } from "../worker/routes/connections.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
        /** One statement of a batch, run inside the batch's transaction. */
        execute() {
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
  return { db: drizzle(binding as never) as unknown as Database, binding, sqlite };
}

async function setup() {
  const { db, binding, sqlite } = freshDb();
  await db.insert(cohorts).values({ id: "cohort_1", slug: "c", name: "Cohort", joinCode: "JOINCODE1", active: true });
  await db.insert(users).values({ id: "user_1", name: "Fixture device", email: "fixture-device@example.test", githubLogin: "fixture-device", cohortId: "cohort_1" });
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
  const start = (body?: unknown) =>
    call("/v1/cli/device/start", {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  return { sqlite, call, start };
}

test("the approval URL never carries a hostname supplied by an older candidate CLI", async (t) => {
  const portal = await setup();
  t.after(() => portal.sqlite.close());
  const hostname = "PRIVATE-HOSTNAME-SENTINEL";
  const response = await portal.start({ deviceName: hostname });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verificationUri, `https://portal.example/connections?user_code=${body.userCode}&return_to=setup`);
  assert.ok(!JSON.stringify(body).includes(hostname));
});

test("an older CLI request without name fields still completes linking", async (t) => {
  const portal = await setup();
  t.after(() => portal.sqlite.close());
  for (const body of [{}, undefined]) {
    const started = await portal.start(body);
    assert.equal(started.status, 200);
    const { verificationUri, userCode, deviceCode } = await started.json();
    assert.equal(verificationUri, `https://portal.example/connections?user_code=${userCode}&return_to=setup`);
    portal.sqlite.prepare("UPDATE device_authorizations SET user_id = ?, device_name = ?, approved_at = ? WHERE user_code = ?")
      .run("user_1", "CogWorks CLI", Date.now(), userCode);
    const response = await portal.call("/v1/cli/device/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode }),
    });
    assert.equal(response.status, 200);
    const token = await response.json();
    assert.equal(token.status, "authorized");
    assert.equal(token.deviceName, "CogWorks CLI");
    assert.ok(token.token.length >= 32);
  }
});

test("the token answer names the device as it was approved, which is what Connections lists", async (t) => {
  const portal = await setup();
  t.after(() => portal.sqlite.close());
  const started = await portal.start({});
  const { deviceCode, userCode } = (await started.json()) as { deviceCode: string; userCode: string };
  // The student renamed it on the form before approving.
  portal.sqlite
    .prepare("UPDATE device_authorizations SET user_id = ?, device_name = ?, approved_at = ? WHERE user_code = ?")
    .run("user_1", "Desk tower", Date.now(), userCode);
  const response = await portal.call("/v1/cli/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string; deviceName?: string };
  assert.equal(body.status, "authorized");
  assert.equal(body.deviceName, "Desk tower");
  const listed = portal.sqlite.prepare("SELECT name FROM cli_devices WHERE user_id = ?").all("user_1");
  assert.deepEqual(listed.map((row) => row.name), ["Desk tower"]);
});
