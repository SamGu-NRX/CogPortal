import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";
import { ApiErrorSchema, SetupEvidenceRequestSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerSetupRoutes } from "../worker/routes/setup.ts";

const migrations = new URL("../migrations/", import.meta.url);
const scopeMigration = "0036_setup_benchmark_scope.sql";
const token = "cog_setup_route_test";
const machineChecks = ["clone", "environment", "project", "wiring"];
const allChecks = [...machineChecks, "test", "run"];

// Only the D1 methods this route uses. SQL and constraints run in SQLite;
// unsupported D1 operations fail rather than returning fabricated results.
function d1Adapter(sqlite: DatabaseSync): AppEnv["Bindings"]["DB"] {
  function prepare(sql: string, parameters: SQLInputValue[] = []): D1PreparedStatement {
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: () => unsupported("first"),
      // SAFETY: node:sqlite's types do not track setReturnArrays. At this
      // host boundary, SQLite returns positional rows as D1.raw expects;
      // Drizzle maps those rows to its selected fields.
      raw: (async (options?: { columnNames?: boolean }): Promise<unknown> => {
        if (options?.columnNames) return unsupported("raw({ columnNames: true })");
        const statement = sqlite.prepare(sql);
        statement.setReturnArrays(true);
        return statement.all(...parameters);
      }) as D1PreparedStatement["raw"],
      all: () => unsupported("all"),
      async run() {
        const result = sqlite.prepare(sql).run(...parameters);
        return {
          success: true,
          results: [],
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
            changed_db: result.changes > 0,
            get duration() { return unsupported("meta.duration"); },
            get size_after() { return unsupported("meta.size_after"); },
            get rows_read() { return unsupported("meta.rows_read"); },
            get rows_written() { return unsupported("meta.rows_written"); },
          },
        };
      },
    };
  }
  function unsupported(method: string): never {
    throw new Error(`Setup route's SQLite fixture does not implement D1.${method}`);
  }
  return {
    prepare,
    batch: () => unsupported("batch"),
    exec: () => unsupported("exec"),
    withSession: () => unsupported("withSession"),
    dump: () => unsupported("dump"),
  };
}

function fixture(t: TestContext) {
  // node:sqlite is available in the platform CI's Node 24 without extra flags.
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  function migrate(name: string) {
    // D1 applies each migration transactionally, including deferred FK checks.
    sqlite.exec(`BEGIN;\n${readFileSync(new URL(name, migrations), "utf8")}\nCOMMIT;`);
  }
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    if (name < scopeMigration) migrate(name);
  }
  sqlite.exec(`
    INSERT INTO users (id, name, email) VALUES
      ('setup_student', 'Setup Student', 'setup@example.test'),
      ('other_student', 'Other Student', 'other@example.test');
    INSERT INTO team_members (team_id, user_id, role) VALUES
      ('team_demo', 'setup_student', 'member'),
      ('team_eigenfaces', 'other_student', 'member');
  `);
  sqlite.prepare(`
    INSERT INTO cli_devices (id, user_id, name, token_hash, created_at, expires_at)
    VALUES ('setup_device', 'setup_student', 'Test device', ?, ?, ?)
  `).run(createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 60_000);
  const insertLegacy = sqlite.prepare(`
    INSERT INTO setup_verifications (user_id, team_id, step, verified_at) VALUES (?, ?, ?, ?)
  `);
  for (const [user, team] of [["setup_student", "team_demo"], ["other_student", "team_eigenfaces"]]) {
    allChecks.forEach((step, index) => insertLegacy.run(user, team, step, 100 + index));
  }
  function rows() {
    return sqlite.prepare("SELECT * FROM setup_verifications ORDER BY user_id, team_id, step, benchmark_id")
      .all().map((row) => ({ ...row }));
  }
  const beforeMigration = sqlite.prepare("SELECT * FROM setup_verifications ORDER BY user_id, team_id, step")
    .all().map((row) => Object.assign({}, row, { benchmark_id: "" }));
  migrate(scopeMigration);

  const app = new Hono<AppEnv>();
  app.onError(handleError);
  registerSetupRoutes(app);
  // SAFETY: this route uses only DB and ENVIRONMENT. Other Worker bindings
  // are deliberately absent so an unexpected dependency fails in this test.
  const env = { DB: d1Adapter(sqlite), ENVIRONMENT: "development" } as AppEnv["Bindings"];
  function post(body: unknown, authorization: string | null = `Bearer ${token}`) {
    return app.request("/v1/cli/setup/checks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization === null ? {} : { Authorization: authorization }),
      },
      body: JSON.stringify(body),
    }, env);
  }
  return { sqlite, rows, beforeMigration, post };
}

// Serialized shape from cogbench.cli._setup_payload, passed by _update_setup.
// The platform CI does not install the Python CLI; this tests its wire shape,
// not Python discovery, token storage, or HTTP serialization itself.
function evidence(checkedBenchmarkId?: string) {
  return {
    schemaVersion: 1,
    repositoryFullName: "cogworks-demo/vector-voyagers",
    checks: machineChecks,
    cliVersion: "0.1.0",
    pythonVersion: "3.8.20",
    benchmarkIds: ["audio-recognition", "language-search"],
    submissionIds: ["audio-recognition", "language-search"],
    ...(checkedBenchmarkId === undefined ? {} : { checkedBenchmarkId }),
  };
}

async function accepted(response: Response, checks = machineChecks) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { accepted: checks });
}

test("the former strict request schema rejects the CLI's checkedBenchmarkId", () => {
  const formerSchema = SetupEvidenceRequestSchema.omit({ checkedBenchmarkId: true });
  assert.equal(formerSchema.safeParse(evidence()).success, true);
  const result = formerSchema.safeParse(evidence("audio-recognition"));
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues.map((issue) => ({ code: issue.code, keys: "keys" in issue ? issue.keys : [] })), [
    { code: "unrecognized_keys", keys: ["checkedBenchmarkId"] },
  ]);
});

test("0036 preserves every existing setup row and timestamp as unscoped evidence", (t) => {
  const f = fixture(t);
  assert.equal(f.beforeMigration.length, 12);
  assert.deepEqual(f.rows(), f.beforeMigration);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => f.sqlite.prepare(`
    INSERT INTO setup_verifications (user_id, team_id, step, verified_at)
    VALUES ('setup_student', 'team_demo', 'clone', 999)
  `).run(), /UNIQUE constraint failed/);
});

test("real device route keeps Audio and Language checks separate and clone unscoped", async (t) => {
  const f = fixture(t);
  await accepted(await f.post(evidence("audio-recognition")));
  const audio = f.rows().filter((row) => row.benchmark_id === "audio-recognition");
  assert.deepEqual(audio.map((row) => row.step), ["environment", "project", "wiring"]);
  assert.ok(audio.every((row) => row.user_id === "setup_student" && row.team_id === "team_demo"));

  await accepted(await f.post(evidence("language-search")));
  assert.deepEqual(f.rows().filter((row) => row.benchmark_id === "audio-recognition"), audio);
  const language = f.rows().filter((row) => row.benchmark_id === "language-search");
  assert.deepEqual(language.map((row) => row.step), ["environment", "project", "wiring"]);
  assert.ok(language.every((row) => row.user_id === "setup_student" && row.team_id === "team_demo"));
  assert.equal(f.rows().length, 18);
  assert.deepEqual(
    f.rows().filter((row) => row.benchmark_id === "" && row.step !== "clone"),
    f.beforeMigration.filter((row) => row.step !== "clone"),
  );
  assert.ok(f.rows().filter((row) => row.step === "clone").every((row) => row.benchmark_id === ""));

  // Force a distinguishable old timestamp without timing-dependent sleeps.
  f.sqlite.exec("UPDATE setup_verifications SET verified_at = 1 WHERE benchmark_id = 'audio-recognition'");
  await accepted(await f.post(evidence("audio-recognition")));
  assert.equal(f.rows().length, 18);
  assert.ok(f.rows().filter((row) => row.benchmark_id === "audio-recognition").every((row) => Number(row.verified_at) > 1));
  assert.deepEqual(f.rows().filter((row) => row.benchmark_id === "language-search"), language);
  assert.deepEqual(
    f.rows().filter((row) => row.user_id === "other_student"),
    f.beforeMigration.filter((row) => row.user_id === "other_student"),
  );
  const device = f.sqlite.prepare("SELECT last_used_at FROM cli_devices WHERE id = 'setup_device'").get();
  assert.ok(Number(device?.last_used_at) > 0);
});

test("legacy CLI evidence remains unscoped without changing scoped evidence", async (t) => {
  const f = fixture(t);
  await accepted(await f.post(evidence("audio-recognition")));
  const scoped = f.rows().filter((row) => row.benchmark_id !== "");
  await accepted(await f.post(evidence()));
  assert.equal(f.rows().length, 15);
  assert.deepEqual(f.rows().filter((row) => row.benchmark_id !== ""), scoped);
  const legacy = f.rows().filter((row) => row.user_id === "setup_student" && row.benchmark_id === "");
  assert.equal(legacy.length, 6);
  assert.ok(legacy.filter((row) => machineChecks.includes(String(row.step))).every((row) => Number(row.verified_at) > 105));
  assert.deepEqual(
    legacy.filter((row) => ["test", "run"].includes(String(row.step))),
    f.beforeMigration.filter((row) => row.user_id === "setup_student" && ["test", "run"].includes(String(row.step))),
  );
});

test("unknown catalog ID rejects the entire request before inserting or updating evidence", async (t) => {
  const f = fixture(t);
  const before = f.rows();
  const response = await f.post(evidence("missing-benchmark"));
  assert.equal(response.status, 400);
  assert.equal(ApiErrorSchema.parse(await response.json()).error.code, "invalid_request");
  assert.deepEqual(f.rows(), before);
});

test("device authentication rejects absent, unknown, expired, and revoked tokens without evidence writes", async (t) => {
  const f = fixture(t);
  const before = f.rows();
  async function rejected(authorization: string | null) {
    const response = await f.post(evidence("audio-recognition"), authorization);
    assert.equal(response.status, 401);
    assert.equal(ApiErrorSchema.parse(await response.json()).error.code, "invalid_token");
    assert.deepEqual(f.rows(), before);
  }
  await rejected(null);
  await rejected("Bearer cog_unknown");
  f.sqlite.exec("UPDATE cli_devices SET expires_at = 1");
  await rejected(`Bearer ${token}`);
  f.sqlite.prepare("UPDATE cli_devices SET expires_at = ?, revoked_at = 1").run(Date.now() + 60_000);
  await rejected(`Bearer ${token}`);
});
