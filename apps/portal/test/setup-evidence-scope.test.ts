import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Database } from "../worker/db/client.ts";
import { benchmarks, cliDevices, cohorts, setupVerifications, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerSetupRoutes } from "../worker/routes/setup.ts";
import { sha256Hex } from "../worker/util/crypto.ts";

/**
 * Which benchmark a `check` was about, from the request to the column.
 *
 * The page's half of this is covered in setup-contract.test.ts. This is the
 * writer: the CLI names the benchmark it checked, and only the steps that are
 * about an environment may carry it. Storing it on `clone` would split one
 * repository fact across every track a student ever checks; storing an id the
 * catalog does not have would grow a primary key and a polled response from
 * anything holding a device token.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const TOKEN = "cog_testdevicetoken";

function freshDb(): { db: Database; binding: unknown } {
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
    },
  };
  return { db: drizzle(binding as never) as unknown as Database, binding };
}

async function seed(db: Database): Promise<void> {
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  await db.insert(users).values({
    id: "user_1",
    name: "student",
    email: "student@example.test",
    emailVerified: true,
    githubLogin: "student",
    cohortId: "cohort_test",
  });
  await db.insert(teams).values({
    id: "team_1",
    cohortId: "cohort_test",
    name: "team_1",
    description: null,
    repoOwner: "cogworks-test",
    repoName: "team_1",
    repoFullName: "cogworks-test/team_1",
    repoUrl: "https://github.com/cogworks-test/team_1",
    defaultBranch: "main",
  });
  await db.insert(teamMembers).values({
    teamId: "team_1",
    userId: "user_1",
    role: "admin",
    joinedAt: NOW,
  });
  await db.insert(cliDevices).values({
    id: "device_1",
    userId: "user_1",
    name: "laptop",
    tokenHash: await sha256Hex(TOKEN),
    createdAt: NOW,
    // Anchored to the real clock, not the fixture's: requireDevice compares
    // expiry against Date.now(), so a constant would expire the token.
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    lastUsedAt: null,
    revokedAt: null,
  });
  // The catalog comes from the migrations themselves, which is the point: the
  // route checks the id against whatever this portal actually publishes.
  const [row] = await db
    .select({ id: benchmarks.id })
    .from(benchmarks)
    .where(eq(benchmarks.id, "vision-clustering"))
    .limit(1);
  assert.ok(row, "the migrations should publish vision-clustering");
}

function env(binding: unknown): Env {
  return {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    PUBLIC_ORIGIN: "https://portal.example",
  } as unknown as Env;
}

async function postChecks(binding: unknown, body: unknown): Promise<number> {
  const app = new Hono<AppEnv>();
  registerSetupRoutes(app);
  app.onError(handleError);
  const response = await app.fetch(
    new Request("http://localhost:5173/v1/cli/setup/checks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
    env(binding),
  );
  return response.status;
}

function payload(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repositoryFullName: "cogworks-test/team_1",
    checks: ["clone", "environment", "project", "wiring"],
    cliVersion: "0.2.0",
    pythonVersion: "3.8.10",
    benchmarkIds: ["vision-clustering"],
    submissionIds: [],
    ...extra,
  };
}

async function storedScopes(db: Database): Promise<Record<string, string>> {
  const rows = await db
    .select({ step: setupVerifications.step, benchmarkId: setupVerifications.benchmarkId })
    .from(setupVerifications);
  return Object.fromEntries(rows.map((row) => [row.step, row.benchmarkId]));
}

test("only the environment steps carry the benchmark the check named", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  assert.equal(await postChecks(binding, payload({ checkedBenchmarkId: "vision-clustering" })), 200);

  // The clone is the repository, and the repository is the same on every
  // track. The other three describe whichever environment was active.
  assert.deepEqual(await storedScopes(db), {
    clone: "",
    environment: "vision-clustering",
    project: "vision-clustering",
    wiring: "vision-clustering",
  });
});

test("a CLI that names no benchmark records evidence no track can claim", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // The pinned CLI before this change. Its evidence is real and it is about
  // the machine; nothing entitles it to tick a track's three lines.
  assert.equal(await postChecks(binding, payload()), 200);

  assert.deepEqual(await storedScopes(db), {
    clone: "",
    environment: "",
    project: "",
    wiring: "",
  });
});

test("a benchmark this portal does not publish is stored unscoped", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // The id reaches a primary key and a response polled every 2.5 s, so an
  // unrecognized one is not taken on trust: the page keys on catalog ids and
  // would never read it back.
  assert.equal(await postChecks(binding, payload({ checkedBenchmarkId: "made-up-track" })), 200);

  const scopes = await storedScopes(db);
  assert.equal(scopes.wiring, "");
  assert.equal(scopes.environment, "");
});
