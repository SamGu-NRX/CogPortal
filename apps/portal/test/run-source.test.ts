import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { runSource } from "@cogworks/contracts/schema";
import type { Database } from "../worker/db/client.ts";
import { cohorts, runs, teams } from "../worker/db/schema.ts";
import { serializeRunDetail } from "../worker/http/serializers.ts";

/**
 * A finished run keeps naming the repository it actually ran from.
 *
 * The run detail payload used to build its repository from the team row, so a
 * team that changed its connected repository rewrote the past: every earlier
 * run rendered under the new repository's name, above the old repository's
 * commit (B-06). These pin the two halves of the repair, the run keeping its
 * own source and an unrecorded source staying unknown, plus the migration's
 * guard, which is the part that decides what history is allowed to claim.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const OLD = "some-student/week1-capstone";
const NEW = "some-student/week3-capstone";
const SHA = "71258046e60fecd3295c0b52236fc6e476b0e9cf";

function migrationFiles(upToAndIncluding?: string): string[] {
  const all = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name));
  if (!upToAndIncluding) return all;
  return all.slice(0, all.indexOf(upToAndIncluding) + 1);
}

function freshDb(files: string[]): { db: Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of files) sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
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
  return { db: drizzle(binding as never) as unknown as Database, sqlite };
}

async function seedTeamOnOldRepository(db: Database, repoId: number | null = 42): Promise<void> {
  await db.insert(cohorts).values({
    id: "cohort_t",
    slug: "t",
    name: "Test cohort",
    joinCode: "JOIN-T",
    active: true,
  });
  await db.insert(teams).values({
    id: "team_1",
    cohortId: "cohort_t",
    name: "team_1",
    description: null,
    repoOwner: "some-student",
    repoName: "week1-capstone",
    repoFullName: OLD,
    repoUrl: `https://github.com/${OLD}`,
    defaultBranch: "main",
    repoId,
  });
}

async function insertRun(
  db: Database,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(runs).values({
    id,
    teamId: "team_1",
    benchmarkId: "audio-identification",
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v2",
    mode: "practice",
    status: "succeeded",
    branch: "main",
    sha: SHA,
    repositoryId: 42,
    repositoryFullName: OLD,
    createdAt: 10,
    finishedAt: 20,
    ...overrides,
  } as never);
}

/** The team as it is now, which is what decides whether a run is still
 *  actionable. What the run *was* comes from the run. */
async function currentTeam(db: Database) {
  const [row] = await db.select().from(teams).where(eq(teams.id, "team_1"));
  return { repoId: row!.repoId, repoFullName: row!.repoFullName };
}

/** The team moves to another repository, the way POST /team/repository does. */
async function changeRepository(db: Database): Promise<void> {
  await db
    .update(teams)
    .set({
      repoOwner: "some-student",
      repoName: "week3-capstone",
      repoFullName: NEW,
      repoUrl: `https://github.com/${NEW}`,
      repoId: 99,
    })
    .where(eq(teams.id, "team_1"));
}

test("a finished run still names its own repository after the team changes repository", async () => {
  const { db } = freshDb(migrationFiles());
  await seedTeamOnOldRepository(db);
  await insertRun(db, "run_old");

  await changeRepository(db);

  const [row] = await db.select().from(runs).where(eq(runs.id, "run_old"));
  const detail = await serializeRunDetail(db, row!, await currentTeam(db));

  assert.equal(detail.repo?.fullName, OLD, "the old run followed the team to its new repository");
  assert.equal(detail.repo?.url, `https://github.com/${OLD}`);
  assert.equal(detail.repo?.owner, "some-student");
  assert.equal(detail.repo?.name, "week1-capstone");
  // The commit was always the run's own. It has to still agree with the name
  // above it, which is the pairing the defect broke.
  assert.equal(detail.sha, SHA);
  // Readable, and no longer promotable: the page shows this instead of a
  // control the server would refuse.
  assert.match(detail.sourceRefusal ?? "", /no longer connected to/);
  assert.match(detail.sourceRefusal ?? "", new RegExp(NEW));
});

test("a run started after the change names the new repository", async () => {
  const { db } = freshDb(migrationFiles());
  await seedTeamOnOldRepository(db);
  await insertRun(db, "run_old");
  await changeRepository(db);
  await insertRun(db, "run_new", { repositoryId: 99, repositoryFullName: NEW });

  const [older] = await db.select().from(runs).where(eq(runs.id, "run_old"));
  const [newer] = await db.select().from(runs).where(eq(runs.id, "run_new"));

  assert.equal((await serializeRunDetail(db, older!, await currentTeam(db))).repo?.fullName, OLD);
  assert.equal((await serializeRunDetail(db, newer!, await currentTeam(db))).repo?.fullName, NEW);
});

test("a run that recorded no repository reports none, not the team's", async () => {
  const { db } = freshDb(migrationFiles());
  await seedTeamOnOldRepository(db);
  await insertRun(db, "run_legacy", { repositoryId: null, repositoryFullName: null });

  const [row] = await db.select().from(runs).where(eq(runs.id, "run_legacy"));
  const detail = await serializeRunDetail(db, row!, await currentTeam(db));

  assert.equal(detail.repo, null, "an unknown source was reported as the current repository");
  assert.equal(detail.sha, SHA, "the run's own commit is still reported");
  assert.match(detail.sourceRefusal ?? "", /predates the repository/);
});

test("the backfill fills a run whose own id proves the repository, and no other", async () => {
  // Applied against the schema as it stood before this migration, so this
  // exercises the shipped SQL rather than a paraphrase of it.
  const before = migrationFiles("0039_setup_check_source.sql");
  const { db, sqlite } = freshDb(before);
  await seedTeamOnOldRepository(db);

  // Three shapes of history: one whose recorded id still matches the team, one
  // from a repository the team has since left, and one from before ids existed.
  // Inserted as SQL because the point is the schema as it stood at 0039, which
  // has no name column for the query builder to fill.
  const insert = sqlite.prepare(
    `insert into runs
       (id, team_id, benchmark_id, benchmark_version, contract_version, mode,
        status, branch, sha, repository_id, created_at, finished_at)
     values (?, 'team_1', 'audio-identification', 1, 'c', 'practice',
             'succeeded', 'main', ?, ?, 1, 2)`,
  );
  insert.run("run_same", SHA, 42);
  insert.run("run_moved", SHA, 7);
  insert.run("run_ancient", SHA, null);

  sqlite.exec(readFileSync(join(MIGRATIONS, "0040_run_repository_name.sql"), "utf8"));

  const named = new Map(
    (await db.select().from(runs)).map((row) => [row.id, row.repositoryFullName]),
  );
  assert.equal(named.get("run_same"), OLD, "a run whose id matches the team was left unnamed");
  assert.equal(named.get("run_moved"), null, "a run from another repository was given this one's name");
  assert.equal(named.get("run_ancient"), null, "a run with no id at all was given a name");
});

test("a name only becomes a link when it is a name", () => {
  assert.equal(runSource(null), null);
  assert.equal(runSource(""), null);
  // Not a full name: no owner, or no repository after the slash.
  assert.equal(runSource("week1-capstone"), null);
  assert.equal(runSource("/week1-capstone"), null);
  assert.equal(runSource("some-student/"), null);
  // Not two components, or not a name at all: each of these would otherwise
  // build a URL pointing somewhere the run never used.
  assert.equal(runSource("owner/repo/extra"), null);
  assert.equal(runSource("owner/../other"), null);
  assert.equal(runSource("owner/repo?tab=readme"), null);
  assert.equal(runSource(" /repo"), null);
  assert.equal(runSource("owner /repo"), null);
  assert.equal(runSource("owner/.."), null, "a dot segment resolves above the repository");
  assert.deepEqual(runSource(OLD), {
    owner: "some-student",
    name: "week1-capstone",
    fullName: OLD,
    url: `https://github.com/${OLD}`,
  });
});
