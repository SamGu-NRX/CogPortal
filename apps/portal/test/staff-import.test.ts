import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { platformRole } from "../worker/auth/roles.ts";
import { STAFF_IMPORT_GRANTED_BY, StaffImportError, staffImportSql } from "../worker/auth/staff-import.ts";
import type { Database } from "../worker/db/client.ts";
import type { Env } from "../worker/env.ts";

/**
 * The upgrade across migration 0031: the roster that used to be
 * PLATFORM_STAFF_LOGINS has to land in platform_staff before the Worker that
 * reads only the table goes live, or instructors lose the admin console on
 * rollout. These apply the generated SQL to a database built from the real
 * migrations and ask the Worker's own role check who is staff.
 */

const PORTAL = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(PORTAL, "migrations");
const GRANTED_AT = 1_790_000_000_000;

function migrated(): { sqlite: DatabaseSync; db: Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  // The surface drizzle's d1 driver calls, as in staff-roster.test.ts.
  const binding = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: never[] = [];
      const prepared = {
        bind(...params: unknown[]) { bound = params as never[]; return prepared; },
        async run() { return { success: true, meta: statement.run(...bound) }; },
        async all() { return { success: true, results: statement.all(...bound) }; },
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
  return { sqlite, db: drizzle(binding as never) as unknown as Database };
}

const env = { PLATFORM_OWNER_LOGINS: "SamOwner" } as Env;

test("an imported roster makes the same people staff the variable did, owners aside", async () => {
  const { sqlite, db } = migrated();
  sqlite.exec(staffImportSql("Alice-TA, bob\ncarol  SamOwner", "samowner", GRANTED_AT));
  for (const login of ["alice-ta", "ALICE-TA", "Bob", "carol", "SamOwner"]) {
    assert.equal(await platformRole(db, env, login), "staff", login);
  }
  assert.equal(await platformRole(db, env, "dave"), "student");
  const rows = sqlite.prepare("SELECT login, display_login, granted_by, granted_at FROM platform_staff ORDER BY login").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { login: "alice-ta", display_login: "Alice-TA", granted_by: STAFF_IMPORT_GRANTED_BY, granted_at: GRANTED_AT },
    { login: "bob", display_login: "bob", granted_by: STAFF_IMPORT_GRANTED_BY, granted_at: GRANTED_AT },
    { login: "carol", display_login: "carol", granted_by: STAFF_IMPORT_GRANTED_BY, granted_at: GRANTED_AT },
  ], "owners are never rows, as in the console");
});

test("a row already on the roster keeps who granted it and when", async () => {
  const { sqlite } = migrated();
  sqlite.exec("INSERT INTO platform_staff VALUES ('bob', 'Bob', 'samowner', 1)");
  sqlite.exec(staffImportSql("BOB,carol", "", GRANTED_AT));
  const bob = sqlite.prepare("SELECT display_login, granted_by, granted_at FROM platform_staff WHERE login = 'bob'").get();
  assert.deepEqual({ ...bob }, { display_login: "Bob", granted_by: "samowner", granted_at: 1 });
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM platform_staff").get()?.n, 2);
});

test("a malformed entry writes nothing, and the message names it", () => {
  for (const roster of ["alice, bad login!", "alice,o'brien", "alice," + "x".repeat(40)]) {
    assert.throws(() => staffImportSql(roster, "", GRANTED_AT),
      (error: unknown) => error instanceof StaffImportError && /is not a GitHub login/.test(error.message));
  }
});

test("a roster of only owners, or nothing, is refused rather than producing an empty import", () => {
  for (const [roster, owners] of [["", ""], [" , \n", ""], ["SamOwner", "samowner"]]) {
    assert.throws(() => staffImportSql(roster, owners, GRANTED_AT), /nothing to import/);
  }
});

test("the CLI reads the roster from stdin and prints the same SQL", () => {
  const tsx = join(PORTAL, "node_modules", ".bin", "tsx");
  const printed = execFileSync(tsx, [join(PORTAL, "scripts", "staff-roster-import.ts"), "--owners", "samowner"], {
    input: "alice,SamOwner", encoding: "utf8",
  });
  const { sqlite } = migrated();
  sqlite.exec(printed);
  assert.deepEqual(sqlite.prepare("SELECT login FROM platform_staff").all().map((row) => row.login), ["alice"]);
  assert.throws(() => execFileSync(tsx, [join(PORTAL, "scripts", "staff-roster-import.ts")], {
    input: "alice", stdio: "pipe",
  }), /usage/);
});
