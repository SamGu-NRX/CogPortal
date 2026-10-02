import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { Database } from "../worker/db/client.ts";
import { cliDevices, cohorts, setupVerifications, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { createCheckOffToken, STALE_TOKEN_MESSAGE } from "../worker/routes/setup-check-off-token.ts";
import { registerSetupRoutes } from "../worker/routes/setup.ts";
import { sha256Hex } from "../worker/util/crypto.ts";

/**
 * Setup evidence is written for a membership, and only while it holds.
 *
 * The check-off command carries a signed token that stays valid for a week
 * after the page minted it. Signing proves who was on which team then, not
 * now, so a student who has since been removed or moved must not be able to
 * write, or refresh, a row for the team they left. The CLI route reads the
 * membership itself, and the same rule has to hold when a removal lands
 * between that read and the write.
 *
 * Both are exercised against the real migrations on SQLite, through the real
 * routes, with tokens from the production minting function.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const SECRET = "test-signing-secret-not-a-real-one";
const DEVICE_TOKEN = "cog_testdevicetoken";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  /** Every statement the binding prepared, in order. */
  const statements: string[] = [];
  /** `beforeSetupWrite` runs once, immediately before the first write to
   *  setup_verifications. */
  const hooks: { beforeSetupWrite?: () => void } = {};
  const binding = {
    prepare(query: string) {
      statements.push(query);
      const statement = sqlite.prepare(query);
      let bound: never[] = [];
      // The latest a concurrent removal could land: after everything the
      // route did before this statement, before the statement itself.
      const interleave = () => {
        if (!/^insert into "setup_verifications"/i.test(query)) return;
        const hook = hooks.beforeSetupWrite;
        hooks.beforeSetupWrite = undefined;
        hook?.();
      };
      const prepared = {
        bind(...params: unknown[]) {
          bound = params as never[];
          return prepared;
        },
        async run() {
          interleave();
          return { success: true, meta: statement.run(...bound) };
        },
        async all() {
          interleave();
          return { success: true, results: statement.all(...bound) };
        },
        async raw() {
          interleave();
          statement.setReturnArrays(true);
          const rows = statement.all(...bound);
          statement.setReturnArrays(false);
          return rows;
        },
      };
      return prepared;
    },
  };
  const db = drizzle(binding as never) as unknown as Database;
  return { db, binding, statements, hooks, sqlite };
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
  for (const id of ["team_1", "team_2"]) {
    await db.insert(teams).values({
      id,
      cohortId: "cohort_test",
      name: id,
      description: null,
      repoOwner: "cogworks-test",
      repoName: id,
      repoFullName: `cogworks-test/${id}`,
      repoUrl: `https://github.com/cogworks-test/${id}`,
      defaultBranch: "main",
    });
  }
  await db.insert(teamMembers).values({
    teamId: "team_1",
    userId: "user_1",
    role: "write",
  });
  await db.insert(cliDevices).values({
    id: "device_1",
    userId: "user_1",
    name: "laptop",
    tokenHash: await sha256Hex(DEVICE_TOKEN),
    createdAt: NOW,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    lastUsedAt: null,
    revokedAt: null,
  });
}

function env(binding: unknown): Env {
  return {
    DB: binding,
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    PUBLIC_ORIGIN: "https://portal.example",
    BETTER_AUTH_SECRET: SECRET,
  } as unknown as Env;
}

function app(): Hono<AppEnv> {
  const hono = new Hono<AppEnv>();
  registerSetupRoutes(hono);
  hono.onError(handleError);
  return hono;
}

async function mint(teamId: string, step = "environment", benchmarkId = "vision-clustering") {
  return createCheckOffToken(SECRET, {
    u: "user_1",
    t: teamId,
    s: step,
    b: benchmarkId,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  } as Parameters<typeof createCheckOffToken>[1]);
}

async function checkOff(binding: unknown, token: string) {
  const response = await app().fetch(
    new Request(`http://localhost:5173/v1/setup/check-off?t=${encodeURIComponent(token)}`, {
      method: "POST",
    }),
    env(binding),
  );
  return { status: response.status, body: await response.text() };
}

async function postChecks(binding: unknown, teamId: string) {
  const response = await app().fetch(
    new Request("http://localhost:5173/v1/cli/setup/checks", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${DEVICE_TOKEN}` },
      body: JSON.stringify({
        schemaVersion: 1,
        repositoryFullName: `cogworks-test/${teamId}`,
        checks: ["clone", "environment"],
        cliVersion: "0.2.0",
        pythonVersion: "3.8.10",
        benchmarkIds: ["vision-clustering"],
        submissionIds: [],
        checkedBenchmarkId: "vision-clustering",
      }),
    }),
    env(binding),
  );
  return { status: response.status, body: await response.json() as { error?: { code?: string } } };
}

async function removeFromTeam(db: Database, teamId: string): Promise<void> {
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.userId, "user_1"), eq(teamMembers.teamId, teamId)));
}

async function rows(db: Database) {
  return db
    .select({
      teamId: setupVerifications.teamId,
      step: setupVerifications.step,
      benchmarkId: setupVerifications.benchmarkId,
      source: setupVerifications.source,
      verifiedAt: setupVerifications.verifiedAt,
    })
    .from(setupVerifications);
}

test("a command copied before the student was removed writes nothing", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const token = await mint("team_1");

  await removeFromTeam(db, "team_1");
  const result = await checkOff(binding, token);

  assert.equal(result.status, 400);
  // The same sentence as an expired command: the remedy is the same, and a
  // leaked copy should not tell its holder whether the student is still on
  // the team.
  assert.equal(result.body, STALE_TOKEN_MESSAGE);
  assert.deepEqual(await rows(db), []);
});

test("a command copied on the old team writes nothing after a move, and the new team's works", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  const oldToken = await mint("team_1");

  await removeFromTeam(db, "team_1");
  await db.insert(teamMembers).values({ teamId: "team_2", userId: "user_1", role: "write" });

  const stale = await checkOff(binding, oldToken);
  assert.equal(stale.status, 400);
  assert.equal(stale.body, STALE_TOKEN_MESSAGE);
  assert.deepEqual(await rows(db), []);

  const fresh = await checkOff(binding, await mint("team_2"));
  assert.equal(fresh.status, 200);
  assert.deepEqual(
    (await rows(db)).map(({ teamId, step, source }) => ({ teamId, step, source })),
    [{ teamId: "team_2", step: "environment", source: "self" }],
  );
});

test("a stale command does not refresh a row from before the removal", async () => {
  const { db, binding } = freshDb();
  await seed(db);
  await db.insert(setupVerifications).values({
    userId: "user_1",
    teamId: "team_1",
    step: "environment",
    benchmarkId: "vision-clustering",
    verifiedAt: NOW,
    source: "self",
  });
  const token = await mint("team_1");

  await removeFromTeam(db, "team_1");
  assert.equal((await checkOff(binding, token)).status, 400);

  const [row] = await rows(db);
  assert.equal(row!.verifiedAt, NOW, "a removed student's command moved the timestamp");
});

test("a removal that lands just before the check-off's write still wins", async () => {
  const harness = freshDb();
  await seed(harness.db);
  const token = await mint("team_1");

  harness.hooks.beforeSetupWrite = () =>
    harness.sqlite.exec("DELETE FROM team_members WHERE user_id = 'user_1' AND team_id = 'team_1'");
  const result = await checkOff(harness.binding, token);

  assert.equal(result.status, 400);
  assert.deepEqual(await rows(harness.db), []);
});

test("the check-off's membership check and its write are one statement", async () => {
  const harness = freshDb();
  await seed(harness.db);
  const token = await mint("team_1");
  harness.statements.length = 0;

  assert.equal((await checkOff(harness.binding, token)).status, 200);

  // A separate read before the write is a window a removal can land in. One
  // statement that selects the membership and inserts from it has none, since
  // SQLite runs each statement atomically.
  assert.equal(harness.statements.length, 1, harness.statements.join("\n"));
  assert.match(harness.statements[0]!, /^insert into "setup_verifications"/i);
  assert.match(harness.statements[0]!, /from "team_members"/i);
});

test("a removal between the CLI's membership read and its write records nothing", async () => {
  const harness = freshDb();
  await seed(harness.db);

  harness.hooks.beforeSetupWrite = () =>
    harness.sqlite.exec("DELETE FROM team_members WHERE user_id = 'user_1' AND team_id = 'team_1'");
  const result = await postChecks(harness.binding, "team_1");

  assert.equal(result.status, 403);
  assert.equal(result.body.error?.code, "no_team");
  assert.deepEqual(await rows(harness.db), []);
});

test("a current member's check-off can be re-run, and keeps what the CLI observed", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // The CLI reported first, at a fixed past time, then the student runs the
  // check-off twice, as they would after a flaky network.
  await db.insert(setupVerifications).values({
    userId: "user_1",
    teamId: "team_1",
    step: "environment",
    benchmarkId: "vision-clustering",
    verifiedAt: NOW,
    source: "cli",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await checkOff(binding, await mint("team_1"));
    assert.equal(result.status, 200);
    assert.match(result.body, /environment/);
  }

  const environment = (await rows(db)).filter((row) => row.step === "environment");
  assert.equal(environment.length, 1, "a re-run added a second row");
  assert.equal(environment[0]!.source, "cli", "an observation was downgraded to a self report");
  assert.ok(environment[0]!.verifiedAt > NOW, "the re-run did not refresh the timestamp");
});

test("the CLI upgrades a self check-off to observed", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  assert.equal((await checkOff(binding, await mint("team_1"))).status, 200);
  assert.equal((await rows(db))[0]!.source, "self");

  assert.equal((await postChecks(binding, "team_1")).status, 200);
  const environment = (await rows(db)).filter((row) => row.step === "environment");
  assert.equal(environment.length, 1);
  assert.equal(environment[0]!.source, "cli");
});
