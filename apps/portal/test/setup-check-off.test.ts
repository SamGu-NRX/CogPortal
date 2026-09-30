import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { SELF_CHECKABLE_SETUP_STEPS } from "@cogworks/contracts/schema";
import type { Database } from "../worker/db/client.ts";
import { cliDevices, cohorts, setupVerifications, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { checkOffExpiry, createCheckOffToken } from "../worker/routes/setup-check-off-token.ts";
import { registerSetupRoutes } from "../worker/routes/setup.ts";
import { sha256Hex } from "../worker/util/crypto.ts";

/**
 * The command a student copies off the setup page, from the token to the row.
 *
 * This is the interaction the page exists for, so the things that would make
 * it lie are what get pinned: a token that ticks a box on a track it was not
 * signed for, a forged or expired token that ticks anything at all, a check-off
 * that overwrites what the CLI actually observed, and a GET that mutates state
 * because something followed a link.
 *
 * Tokens are minted with the production `createCheckOffToken`, so these cover
 * the mint and the verify together. A test that re-implemented the encoding
 * would have pinned only half of the scheme, and the half the page depends on
 * is the half it would have left out.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const NOW = 1_780_000_000_000;
const SECRET = "test-signing-secret-not-a-real-one";
const DEVICE_TOKEN = "cog_testdevicetoken";

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

async function mint(
  payload: { u: string; t: string; s: string; b: string; exp: number },
  secret = SECRET,
): Promise<string> {
  return createCheckOffToken(secret, payload as Parameters<typeof createCheckOffToken>[1]);
}

function future(): number {
  return Math.floor(Date.now() / 1_000) + 3_600;
}

async function checkOff(
  binding: unknown,
  token: string,
  method = "POST",
): Promise<{ status: number; body: string }> {
  const app = new Hono<AppEnv>();
  registerSetupRoutes(app);
  app.onError(handleError);
  const response = await app.fetch(
    new Request(`http://localhost:5173/v1/setup/check-off?t=${encodeURIComponent(token)}`, {
      method,
    }),
    env(binding),
  );
  return { status: response.status, body: await response.text() };
}

async function rows(db: Database) {
  return db
    .select({
      step: setupVerifications.step,
      benchmarkId: setupVerifications.benchmarkId,
      source: setupVerifications.source,
    })
    .from(setupVerifications);
}

test("a copied command records the step it was signed for", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  const token = await mint({
    u: "user_1",
    t: "team_1",
    s: "environment",
    b: "vision-clustering",
    exp: future(),
  });
  const result = await checkOff(binding, token);

  assert.equal(result.status, 200);
  assert.match(result.body, /environment/);
  assert.deepEqual(await rows(db), [
    { step: "environment", benchmarkId: "vision-clustering", source: "self" },
  ]);
});

test("a check-off ticks its own track and no other", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // The benchmark is inside the signature, so a command copied on one track
  // cannot land on another. This is the failure the old unscoped token had.
  await checkOff(
    binding,
    await mint({ u: "user_1", t: "team_1", s: "project", b: "vision-clustering", exp: future() }),
  );

  const stored = await rows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.benchmarkId, "vision-clustering");
  assert.notEqual(stored[0]!.benchmarkId, "audio-identification");
});

test("the clone check-off stays unscoped, because a repository is one repository", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  await checkOff(
    binding,
    await mint({ u: "user_1", t: "team_1", s: "clone", b: "", exp: future() }),
  );

  assert.deepEqual(await rows(db), [{ step: "clone", benchmarkId: "", source: "self" }]);
});

test("a forged or expired token records nothing", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  const wrongSecret = await mint(
    { u: "user_1", t: "team_1", s: "clone", b: "", exp: future() },
    "not-the-deployment-secret",
  );
  assert.equal((await checkOff(binding, wrongSecret)).status, 400);

  const expired = await mint({
    u: "user_1",
    t: "team_1",
    s: "clone",
    b: "",
    exp: Math.floor(Date.now() / 1_000) - 1,
  });
  assert.equal((await checkOff(binding, expired)).status, 400);

  assert.equal((await checkOff(binding, "not-even-a-token")).status, 400);
  assert.deepEqual(await rows(db), []);
});

test("following the address does not tick the box", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // The token travels in a URL, which a link prefetcher, a chat unfurl or a
  // corporate scanner may fetch. Only a POST writes.
  const token = await mint({
    u: "user_1",
    t: "team_1",
    s: "clone",
    b: "",
    exp: future(),
  });
  const got = await checkOff(binding, token, "GET");

  assert.notEqual(got.status, 200);
  assert.deepEqual(await rows(db), []);
});

test("a check-off never overwrites what the CLI observed", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  await db.insert(setupVerifications).values({
    userId: "user_1",
    teamId: "team_1",
    step: "environment",
    benchmarkId: "vision-clustering",
    verifiedAt: NOW,
    source: "cli",
  });

  await checkOff(
    binding,
    await mint({
      u: "user_1",
      t: "team_1",
      s: "environment",
      b: "vision-clustering",
      exp: future(),
    }),
  );

  const repeat = await checkOff(
    binding,
    await mint({
      u: "user_1",
      t: "team_1",
      s: "environment",
      b: "vision-clustering",
      exp: future(),
    }),
  );
  // It has to succeed, not merely leave the row alone: a student re-running
  // after a flaky network should see the same friendly line, and a test that
  // only checked the row would pass if the route had started refusing.
  assert.equal(repeat.status, 200);

  const stored = await db
    .select({ source: setupVerifications.source, verifiedAt: setupVerifications.verifiedAt })
    .from(setupVerifications);
  assert.equal(stored.length, 1, "the check-off should not have added a second row");
  assert.equal(stored[0]!.source, "cli", "an observation was downgraded to a self report");
  assert.ok(stored[0]!.verifiedAt > NOW, "the repeat check-off did not touch the row");
});

test("a token is byte-identical while the page is polling", async () => {
  // The setup page refetches every 2.5s while a step is outstanding. An expiry
  // taken straight from the clock changed the command's text on every poll,
  // under a student trying to select it by hand.
  const payload = { u: "user_1", t: "team_1", s: "clone", b: "", exp: checkOffExpiry() };
  const first = await createCheckOffToken(SECRET, payload as never);
  const second = await createCheckOffToken(SECRET, {
    ...payload,
    exp: checkOffExpiry(Date.now() + 60_000),
  } as never);
  assert.equal(first, second);
});

test("every step the page offers a command for can actually be checked off", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  for (const step of SELF_CHECKABLE_SETUP_STEPS) {
    const result = await checkOff(
      binding,
      await mint({ u: "user_1", t: "team_1", s: step, b: "", exp: future() }),
    );
    assert.equal(result.status, 200, `${step} was refused`);
  }
  assert.equal((await rows(db)).length, SELF_CHECKABLE_SETUP_STEPS.length);
});

test("wiring cannot be checked off by hand", async () => {
  const { db, binding } = freshDb();
  await seed(db);

  // `wiring` is what `check` decides. The page offers no command for it, and
  // a correctly signed token naming it is still refused: a student could
  // otherwise call their entry points wired without ever having called them.
  assert.ok(!(SELF_CHECKABLE_SETUP_STEPS as readonly string[]).includes("wiring"));

  const signed = await mint({
    u: "user_1",
    t: "team_1",
    s: "wiring",
    b: "vision-clustering",
    exp: future(),
  });
  assert.equal((await checkOff(binding, signed)).status, 400);
  assert.deepEqual(await rows(db), []);
});
