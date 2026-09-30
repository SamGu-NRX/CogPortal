import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { drizzle } from "drizzle-orm/d1";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { LocalReportInputSchema, type LocalReport } from "@cogworks/contracts/schema";
import type { Database } from "../worker/db/client.ts";
import { cohorts, localReports, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { listTeamLocalReports, upsertLocalReport } from "../worker/services/local-reports.ts";
import { LocalReportsTable } from "../src/components/LocalReportsTable.tsx";

/**
 * `cogworks test` and `cogworks run` both save a report and `sync` sends the
 * newest, so a smoke-test number used to reach the dashboard looking exactly
 * like a practice result. These follow a report file through the same schema
 * the route parses with, into the table, back out, and onto the page.
 *
 * The legacy file is a report the CLI really wrote before it recorded the
 * command (the Python suite's own fixture), so "old reports still sync" is
 * checked against real bytes rather than a hand-built object.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");
const LEGACY = JSON.parse(readFileSync(
  join(HERE, "..", "..", "..", "python", "cogbench", "tests", "fixtures", "audio_no_weight_report.json"),
  "utf8",
)) as Record<string, unknown>;
const REPO = String(LEGACY.repositoryFullName);

/* Same in-memory D1 stand-in as local-reports.test.ts, built from the real
 * migrations so the new column's CHECK constraint is the one under test. */
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
  return { prepare, sqlite };
}

async function seeded(): Promise<{ env: Env; db: Database; sqlite: DatabaseSync }> {
  const binding = freshBinding() as { sqlite: DatabaseSync };
  const db = drizzle(binding as never) as unknown as Database;
  await db.insert(cohorts).values({
    id: "cohort_1", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true,
  });
  await db.insert(users).values({
    id: "user_1", name: "Ada", email: "ada@example.com", githubLogin: "ada",
  });
  const [owner, name] = REPO.split("/");
  await db.insert(teams).values({
    id: "team_1", cohortId: "cohort_1", name: "Analytical Engines",
    repoOwner: owner, repoName: name, repoFullName: REPO,
    repoUrl: `https://github.com/${REPO}`, defaultBranch: "main",
  });
  await db.insert(teamMembers).values({ teamId: "team_1", userId: "user_1", role: "admin" });
  return { env: { DB: binding } as unknown as Env, db, sqlite: binding.sqlite };
}

/** What the route does with a request body, then the stored report. */
async function sync(env: Env, file: Record<string, unknown>): Promise<LocalReport> {
  const { report } = await upsertLocalReport(env, "user_1", LocalReportInputSchema.parse(file));
  return report;
}

function page(reports: LocalReport[]): string {
  return renderToStaticMarkup(React.createElement(LocalReportsTable, { reports }));
}

test("each command a report names survives sync and is shown with its row", async () => {
  const { env } = await seeded();
  await sync(env, { ...LEGACY, reportId: "local_from_test", command: "test" });
  await sync(env, { ...LEGACY, reportId: "local_from_run", command: "run" });

  const listed = await listTeamLocalReports(env, "user_1");
  const byId = new Map(listed.map((report) => [report.reportId, report.command]));
  assert.equal(byId.get("local_from_test"), "test");
  assert.equal(byId.get("local_from_run"), "run");

  const html = page(listed);
  assert.match(html, />Command</);
  assert.match(html, /<td class="py-2\.5 font-mono text-ink-secondary">test<\/td>/);
  assert.match(html, /<td class="py-2\.5 font-mono text-ink-secondary">run<\/td>/);
  // The note explains a test row, and only appears when one is on screen.
  assert.match(html, /scored only the small\s+smoke-test cases/);
  assert.doesNotMatch(page(listed.filter((r) => r.command === "run")), /smoke-test cases/);
});

test("a report the CLI wrote before recording the command syncs and reads as unrecorded", async () => {
  const { env, sqlite } = await seeded();
  assert.equal("command" in LEGACY, false);
  const stored = await sync(env, LEGACY);

  assert.equal(stored.command, undefined);
  const row = sqlite.prepare("SELECT command FROM local_reports WHERE report_id = ?")
    .get(String(LEGACY.reportId)) as { command: unknown };
  assert.equal(row.command, null);

  const html = page(await listTeamLocalReports(env, "user_1"));
  assert.match(html, /<td class="py-2\.5 font-mono text-ink-faint">not recorded<\/td>/);
  // Never guessed as either command.
  assert.doesNotMatch(html, />(test|run)<\/td>/);
  assert.doesNotMatch(html, /smoke-test cases/);
});

test("a command the CLI never writes is refused at the schema", () => {
  for (const command of ["practice", "RUN", "", null, 1]) {
    const parsed = LocalReportInputSchema.safeParse({ ...LEGACY, command });
    assert.equal(parsed.success, false, `accepted ${JSON.stringify(command)}`);
    assert.deepEqual(parsed.error?.issues.map((issue) => issue.path), [["command"]]);
  }
});

test("the column refuses what the schema refuses", async () => {
  const { db } = await seeded();
  await assert.rejects(
    db.insert(localReports).values({
      reportId: "local_bad", userId: "user_1", benchmarkId: "audio", benchmarkVersion: 1,
      contractVersion: "1", sdkVersion: "0.2.0", pluginVersion: "0.2.0", repositoryId: null,
      repositoryFullName: REPO, sha: null, dirty: false, startedAt: 1, finishedAt: 2,
      metricsJson: "[]", diagnosticsJson: "[]", syncedAt: 3,
      command: "practice" as never,
    }),
    (error: unknown) => /CHECK constraint failed/.test(String((error as Error).cause)),
  );
});
