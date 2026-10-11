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
import { isPlatformOwner, platformRole } from "../worker/auth/roles.ts";
import type { Database } from "../worker/db/client.ts";
import { cohorts, platformStaff, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerAdminRoutes } from "../worker/routes/admin.ts";

/**
 * Who counts as staff used to be PLATFORM_STAFF_LOGINS, a comma-separated
 * environment variable, so changing it meant editing a Cloudflare secret and
 * redeploying. Migration 0031 moved that roster into a table owners edit from
 * the admin console, and left owners in the environment.
 *
 * Splitting the two is what makes the table safe, and the split is the thing
 * worth testing. If owners were also in the table, an empty table (every fresh
 * database) would leave nobody able to reach the only endpoint that can add a
 * row, and anyone who could write the table could make themselves an owner.
 * These tests drive the real endpoints through the real session layer, because
 * the property being checked is an authorization decision, and a mocked guard
 * would be a test of the mock.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/*
 * The real D1 binding is a Cloudflare object we cannot construct here. This is
 * the surface drizzle's d1 driver calls, backed by in-process SQLite built
 * from the same migration files that run against D1, matching the harness in
 * refund-cap.test.ts.
 */
function freshBinding(): unknown {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    // The seed and backfill migrations insert a demo cohort and derive account
    // rows. Neither is part of an authorization decision, and both add rows
    // these assertions would then have to work around.
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
const SECOND_OWNER = "GraceOwner";

interface Harness {
  env: Env;
  db: Database;
  /** Signs a person in and returns the cookie header for their session. */
  signIn(githubLogin: string): Promise<string>;
  /** The cohort /admin/overview needs before it can answer at all. */
  seedCohort(): Promise<void>;
  /** A request to the admin API. Omit `cookie` for an anonymous caller. */
  call(
    method: string,
    path: string,
    options?: { cookie?: string; body?: unknown },
  ): Promise<{ status: number; body: any }>;
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
    // Two owners, one of them cased differently from how anyone will type it,
    // because GitHub logins are case-insensitive and the env list this
    // replaces was compared that way.
    PLATFORM_OWNER_LOGINS: `${OWNER},${SECOND_OWNER}`,
  } as unknown as Env;
  const db = drizzle(binding as never) as unknown as Database;

  const app = new Hono<AppEnv>();
  registerAdminRoutes(app);
  app.onError(handleError);

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
      // A GitHub sign-in writes github_login through mapProfileToUser. Email
      // signup is the only account path available in a node test, so the
      // column is set here to reach the same state a real sign-in leaves.
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
    async call(method, path, options = {}) {
      const response = await app.fetch(
        new Request(`http://localhost:5173${path}`, {
          method,
          headers: {
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        }),
        env,
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

/* ── The role decision itself ──────────────────────────────────────────── */

test("a login on the roster is staff", async () => {
  const { db, env } = harness();
  await db.insert(platformStaff).values({
    login: "tessa",
    displayLogin: "Tessa",
    grantedBy: OWNER,
    grantedAt: 1_780_000_000_000,
  });
  assert.equal(await platformRole(db, env, "Tessa"), "staff");
  // Capitalization is not identity on GitHub, so it must not be here either.
  assert.equal(await platformRole(db, env, "TESSA"), "staff");
});

test("a login that is not on the roster is a student", async () => {
  const { db, env } = harness();
  await db.insert(platformStaff).values({
    login: "tessa",
    displayLogin: "Tessa",
    grantedBy: OWNER,
    grantedAt: 1_780_000_000_000,
  });
  assert.equal(await platformRole(db, env, "someone-else"), "student");
  // The empty login is what authorizationLogin returns for an account with no
  // GitHub identity. It must never match a row, including a row written empty.
  assert.equal(await platformRole(db, env, ""), "student");
});

test("an owner is staff with no roster row", async () => {
  const { db, env } = harness();
  // The table is empty, which is the state of every fresh database.
  assert.deepEqual(await db.select().from(platformStaff), []);
  assert.equal(await platformRole(db, env, OWNER), "staff");
  assert.equal(await platformRole(db, env, "gracEOWNER"), "staff");
  assert.equal(isPlatformOwner(env, OWNER), true);
});

test("the roster cannot make somebody an owner", async () => {
  const { db, env } = harness();
  await db.insert(platformStaff).values({
    login: "tessa",
    displayLogin: "Tessa",
    grantedBy: OWNER,
    grantedAt: 1_780_000_000_000,
  });
  // Staff, yes. Owner, no: ownership is read from the environment and the
  // table is never consulted for it. This is what stops a writable roster
  // from being an escalation path to the owner-only endpoints.
  assert.equal(await platformRole(db, env, "Tessa"), "staff");
  assert.equal(isPlatformOwner(env, "Tessa"), false);
});

/* ── The endpoints ─────────────────────────────────────────────────────── */

test("the roster endpoints refuse an unauthenticated caller", async () => {
  const h = harness();
  for (const [method, path, body] of [
    ["GET", "/admin/staff", undefined],
    ["POST", "/admin/staff", { login: "tessa" }],
    ["DELETE", "/admin/staff/tessa", undefined],
  ] as const) {
    const response = await h.call(method, path, { body });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.body.error.code, "unauthorized");
  }
  // And nothing was written on the way to being refused.
  assert.deepEqual(await h.db.select().from(platformStaff), []);
});

test("an owner adds a login and that login becomes staff", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);

  const added = await h.call("POST", "/admin/staff", {
    cookie: owner,
    body: { login: "Tessa" },
  });
  assert.equal(added.status, 200);
  assert.deepEqual(
    added.body.entries.map((entry: { login: string }) => entry.login),
    ["Tessa"],
  );
  // The casing the owner typed is what reads back. An owner who types
  // "Tessa" and sees "tessa" has no way to tell whether it worked.
  assert.equal(added.body.entries[0].grantedBy, OWNER);
  // Nobody signed in with that login, so the console says so rather than
  // showing an entry that silently grants nothing.
  assert.equal(added.body.entries[0].name, null);
  assert.deepEqual(added.body.owners, [OWNER, SECOND_OWNER]);

  assert.equal(await platformRole(h.db, h.env, "tessa"), "staff");
});

test("an added login resolves to its account once that person signs in", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);
  // Added before they have an account, which is the reason the roster holds a
  // login string instead of a user id.
  await h.call("POST", "/admin/staff", { cookie: owner, body: { login: "TESSA" } });
  await h.signIn("Tessa");

  const roster = await h.call("GET", "/admin/staff", { cookie: owner });
  assert.equal(roster.body.entries[0].name, "Tessa");
});

test("removing a login takes staff access away", async () => {
  const h = harness();
  await h.seedCohort();
  const owner = await h.signIn(OWNER);
  await h.call("POST", "/admin/staff", { cookie: owner, body: { login: "Tessa" } });
  const staff = await h.signIn("Tessa");

  // Staff reach the console while they are on the roster. The scope is "ta"
  // rather than "owner": being on the roster is not being an owner.
  const before = await h.call("GET", "/admin/overview", { cookie: staff });
  assert.equal(before.status, 200);
  assert.equal(before.body.scope, "ta");
  assert.equal(await platformRole(h.db, h.env, "Tessa"), "staff");

  // Removal is by the login as typed; matching is case-insensitive.
  const removed = await h.call("DELETE", "/admin/staff/TESSA", { cookie: owner });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.entries, []);

  assert.equal(await platformRole(h.db, h.env, "Tessa"), "student");
  const afterRemoval = await h.call("GET", "/admin/overview", { cookie: staff });
  assert.equal(afterRemoval.status, 403);
  assert.equal(afterRemoval.body.error.code, "forbidden");
});

test("removing a login that is not on the roster is not an error", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);
  const response = await h.call("DELETE", "/admin/staff/nobody", { cookie: owner });
  // The same idempotent shape as the member and TA removals next to it: the
  // caller asked for a state that already holds.
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.entries, []);
});

test("re-adding somebody keeps the original grant", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);
  await h.call("POST", "/admin/staff", { cookie: owner, body: { login: "Tessa" } });
  const first = await h.call("GET", "/admin/staff", { cookie: owner });

  const secondOwner = await h.signIn(SECOND_OWNER);
  await h.call("POST", "/admin/staff", { cookie: secondOwner, body: { login: "tessa" } });
  const second = await h.call("GET", "/admin/staff", { cookie: owner });

  // One row, and it still records who granted access first. Overwriting that
  // would make the audit trail report the most recent click instead.
  assert.equal(second.body.entries.length, 1);
  assert.equal(second.body.entries[0].grantedBy, OWNER);
  assert.equal(second.body.entries[0].grantedAt, first.body.entries[0].grantedAt);
});

test("staff cannot grant or revoke staff", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);
  await h.call("POST", "/admin/staff", { cookie: owner, body: { login: "Tessa" } });
  const staff = await h.signIn("Tessa");

  // Staff granting staff is an escalation: a TA who could add a login could
  // add their own second account, and the roster would stop meaning what the
  // owner set it to. Reading it is owner-only for the same reason.
  for (const [method, path, body] of [
    ["GET", "/admin/staff", undefined],
    ["POST", "/admin/staff", { login: "accomplice" }],
    ["DELETE", "/admin/staff/Tessa", undefined],
  ] as const) {
    const response = await h.call(method, path, { cookie: staff, body });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.body.error.code, "forbidden");
  }

  // And the roster is exactly as the owner left it.
  const roster = await h.call("GET", "/admin/staff", { cookie: owner });
  assert.deepEqual(
    roster.body.entries.map((entry: { login: string }) => entry.login),
    ["Tessa"],
  );
});

test("a student cannot read or write the roster", async () => {
  const h = harness();
  const student = await h.signIn("student-one");
  const response = await h.call("POST", "/admin/staff", {
    cookie: student,
    body: { login: "student-one" },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await h.db.select().from(platformStaff), []);
});

/* ── Nobody can be locked out ──────────────────────────────────────────── */

test("emptying the roster leaves owners with access", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);
  await h.call("POST", "/admin/staff", { cookie: owner, body: { login: "Tessa" } });
  await h.call("DELETE", "/admin/staff/Tessa", { cookie: owner });

  // The empty table is the state of every fresh deployment, so this is the
  // bootstrap as much as it is a recovery: an owner is still staff, still
  // reaches the console, and can still add the first row.
  assert.deepEqual(await h.db.select().from(platformStaff), []);
  assert.equal(await platformRole(h.db, h.env, OWNER), "staff");
  const readded = await h.call("POST", "/admin/staff", {
    cookie: owner,
    body: { login: "Tessa" },
  });
  assert.equal(readded.status, 200);
  assert.equal(readded.body.entries.length, 1);
});

test("an owner who removes their own roster entry keeps access", async () => {
  const h = harness();
  const owner = await h.signIn(OWNER);
  // An owner may appear on the roster; it is only a login string and the
  // endpoint does not special-case them. Removing it must not matter, because
  // their access never came from the row.
  await h.call("POST", "/admin/staff", { cookie: owner, body: { login: OWNER } });
  const removed = await h.call("DELETE", `/admin/staff/${OWNER}`, { cookie: owner });

  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.entries, []);
  assert.equal(await platformRole(h.db, h.env, OWNER), "staff");
  assert.equal((await h.call("GET", "/admin/staff", { cookie: owner })).status, 200);
});
