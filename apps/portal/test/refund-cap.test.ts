import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "../worker/db/client.ts";
import { cohorts, officialAttempts, runs, teams } from "../worker/db/schema.ts";
import { maintainPlatform } from "../worker/execution/maintenance.ts";
import { REFUND_CAP, refundOfficialAttempt } from "../worker/execution/refunds.ts";
import { syncRun } from "../worker/execution/sync.ts";

/**
 * A run that fails on the platform's side gives the team's official attempt
 * back. Nothing counted those refunds and nothing stopped them, so a
 * submission that reliably provoked a platform-side failure could be replayed
 * without ever spending an attempt.
 *
 * Three code paths delete the attempt row: execution/sync.ts for fixture runs,
 * execution/maintenance.ts for runs the provider stopped reporting on, and
 * routes/runner-events.ts for the live callback. They end a run in three
 * different ways and cannot share a terminal write, so what they share is the
 * decision in execution/refunds.ts. These tests exercise that decision and
 * then the two paths that can be driven end to end here, because a cap
 * enforced in one path and not another is not a cap.
 */

/*
 * The real D1 binding is a Cloudflare object we cannot construct in a node
 * test. This is the smallest surface drizzle's d1 driver calls (bind, run,
 * all, raw; see drizzle-orm/d1/session.js), backed by in-process SQLite built
 * from the same migration files that run against D1.
 *
 * A mocked query builder would not do. The per-team, per-benchmark grain of
 * the cap lives entirely in a WHERE clause, and only a real database can say
 * whether that clause counts the right rows.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** A D1-shaped binding plus the drizzle handle these tests read it through. */
interface Harness {
  db: Database;
  /** What a worker Env carries as `DB`. maintainPlatform takes the Env. */
  binding: unknown;
}

function freshDb(): Harness {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    // The seed and backfill migrations insert demo teams, runs, and claimed
    // attempts. Counting refunds is counting rows, so a test sharing a table
    // with fixture data is a test whose numbers move when the demo cohort
    // changes.
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
  const binding = { prepare };
  return { db: drizzle(binding as never), binding };
}

const NOW = 1_780_000_000_000;
const VISION = "vision-recognition";
const AUDIO = "audio-identification";

/** A fixture branch whose scripted failure is ours, not the team's. */
const PLATFORM_FAILURE_BRANCH = "missing-adapter";
/** Long enough past createdAt that every fixture phase has elapsed. */
const FIXTURE_RUN_MS = 30_000;

async function seedTeams(db: Database, teamIds: string[]): Promise<void> {
  await db.insert(cohorts).values({
    id: "cohort_test",
    slug: "test",
    name: "Test cohort",
    joinCode: "TESTCODE",
    active: true,
  });
  for (const id of teamIds) {
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
}

interface RunOptions {
  id: string;
  teamId: string;
  benchmarkId?: string;
  mode?: "practice" | "official";
  status?: "queued" | "failed" | "succeeded";
  branch?: string;
  provider?: "fixture" | "modal";
  createdAt?: number;
  failureDetail?: string | null;
  /** Set to mark this run as already refunded, the way a real refund does. */
  refundedAt?: number | null;
}

/** An official run with its attempt claimed, the state a real promotion leaves. */
async function claimedRun(db: Database, options: RunOptions): Promise<void> {
  const mode = options.mode ?? "official";
  const benchmarkId = options.benchmarkId ?? VISION;
  await db.insert(runs).values({
    id: options.id,
    teamId: options.teamId,
    benchmarkId,
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1",
    mode,
    status: options.status ?? "queued",
    branch: options.branch ?? PLATFORM_FAILURE_BRANCH,
    sha: "a".repeat(40),
    repositoryId: null,
    parentRunId: null,
    attemptNumber: mode === "official" ? 1 : null,
    failureCategory: null,
    failurePhase: null,
    failureDetail: options.failureDetail ?? null,
    failureConsumedAttempt: false,
    refundedAt: options.refundedAt ?? null,
    log: null,
    createdAt: options.createdAt ?? NOW,
    finishedAt: null,
    provider: options.provider ?? "fixture",
    lastEventSequence: -1,
    surfaceId: null,
  });
  if (mode !== "official") return;
  await db.insert(officialAttempts).values({
    id: `attempt_${options.id}`,
    teamId: options.teamId,
    benchmarkId,
    benchmarkVersion: 1,
    runId: options.id,
    // Real attempt numbers are 1..3 per benchmark and the table is unique on
    // (team, benchmark, version, number). These tests create more failed runs
    // than a team could ever really promote, so the number is derived from the
    // run id purely to keep that index satisfied.
    attemptNumber: Number(options.id.replace(/\D/g, "")) || 1,
    consumed: false,
    claimedAt: options.createdAt ?? NOW,
  });
}

/** Records `count` past refunds for a team on one benchmark. */
async function priorRefunds(
  db: Database,
  teamId: string,
  benchmarkId: string,
  howMany: number,
): Promise<void> {
  for (let index = 0; index < howMany; index += 1) {
    await claimedRun(db, {
      id: `run_prior_${teamId}_${benchmarkId}_${index}`,
      teamId,
      benchmarkId,
      status: "failed",
      refundedAt: NOW - 1_000,
    });
    // A real refund deletes the claim. Leaving it would make the fixture
    // disagree with itself about whether the attempt came back.
    await db
      .delete(officialAttempts)
      .where(eq(officialAttempts.runId, `run_prior_${teamId}_${benchmarkId}_${index}`));
  }
}

async function attemptExists(db: Database, runId: string): Promise<boolean> {
  const rows = await db
    .select({ id: officialAttempts.id })
    .from(officialAttempts)
    .where(eq(officialAttempts.runId, runId));
  return rows.length > 0;
}

async function refundCount(
  db: Database,
  teamId: string,
  benchmarkId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(runs)
    .where(
      and(
        eq(runs.teamId, teamId),
        eq(runs.benchmarkId, benchmarkId),
        isNotNull(runs.refundedAt),
      ),
    );
  return row?.value ?? 0;
}

async function runRow(db: Database, runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  assert.ok(row, `run ${runId} is missing`);
  return row;
}

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------

test("a refund below the cap gives the attempt back and records that it did", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP - 1);
  await claimedRun(db, { id: "run_1", teamId: "team_a", status: "failed" });

  const outcome = await refundOfficialAttempt(db, await runRow(db, "run_1"), NOW);

  assert.equal(outcome, "refunded");
  assert.equal(await attemptExists(db, "run_1"), false);
  // Recorded, not just granted. Nothing counted refunds before migration 0029,
  // which is why the cap could not exist.
  assert.equal((await runRow(db, "run_1")).refundedAt, NOW);
  assert.equal(await refundCount(db, "team_a", VISION), REFUND_CAP);
});

test("the refund at the cap is refused and the attempt stays spent", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_1", teamId: "team_a", status: "failed" });

  const outcome = await refundOfficialAttempt(db, await runRow(db, "run_1"), NOW);

  assert.equal(outcome, "capped");
  assert.equal(await attemptExists(db, "run_1"), true);
  assert.equal((await runRow(db, "run_1")).refundedAt, null);
  // A refused refund is not itself a refund, so it must not push the team
  // further past the cap and change what the admin overview shows.
  assert.equal(await refundCount(db, "team_a", VISION), REFUND_CAP);
});

test("one team at the cap does not stop another team's refund", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a", "team_b"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_b", teamId: "team_b", status: "failed" });

  const outcome = await refundOfficialAttempt(db, await runRow(db, "run_b"), NOW);

  assert.equal(outcome, "refunded");
  assert.equal(await attemptExists(db, "run_b"), false);
});

test("a team at the cap on one benchmark is still refunded on another", async () => {
  // The cap is about one benchmark going wrong for one team. Counting a team's
  // refunds across every benchmark would take attempts away on week 3 because
  // of what the platform did to them in week 1.
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_v", teamId: "team_a", benchmarkId: VISION, status: "failed" });
  await claimedRun(db, { id: "run_a", teamId: "team_a", benchmarkId: AUDIO, status: "failed" });

  assert.equal(await refundOfficialAttempt(db, await runRow(db, "run_v"), NOW), "capped");
  assert.equal(await refundOfficialAttempt(db, await runRow(db, "run_a"), NOW), "refunded");
  assert.equal(await attemptExists(db, "run_a"), false);
});

test("a practice run has no attempt to give back", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await claimedRun(db, { id: "run_p", teamId: "team_a", mode: "practice", status: "failed" });

  assert.equal(await refundOfficialAttempt(db, await runRow(db, "run_p"), NOW), "not_applicable");
  assert.equal((await runRow(db, "run_p")).refundedAt, null);
});

test("a run that was already refunded is not refunded a second time", async () => {
  // Every caller can re-enter this decision: the fixture path runs on each
  // poll and the reaper runs every five minutes. Without the guard a refunded
  // run would rewrite its own timestamp forever, and each rewrite would count
  // once more against the team's cap.
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await claimedRun(db, {
    id: "run_1",
    teamId: "team_a",
    status: "failed",
    refundedAt: NOW - 5_000,
  });

  assert.equal(await refundOfficialAttempt(db, await runRow(db, "run_1"), NOW), "not_applicable");
  assert.equal((await runRow(db, "run_1")).refundedAt, NOW - 5_000);
  assert.equal(await refundCount(db, "team_a", VISION), 1);
});

// ---------------------------------------------------------------------------
// The fixture path (execution/sync.ts)
// ---------------------------------------------------------------------------

test("the fixture path refunds a platform failure below the cap", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP - 1);
  await claimedRun(db, { id: "run_1", teamId: "team_a" });

  const synced = await syncRun(db, await runRow(db, "run_1"), NOW + FIXTURE_RUN_MS);

  assert.equal(synced.status, "failed");
  assert.equal(synced.failureCategory, "adapter_missing");
  assert.equal(await attemptExists(db, "run_1"), false);
  assert.equal(synced.refundedAt, NOW + FIXTURE_RUN_MS);
  assert.equal(synced.failureConsumedAttempt, false);
  assert.doesNotMatch(synced.failureDetail ?? "", /stays spent/);
});

test("the fixture path at the cap fails the run, keeps the attempt, and says so", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_1", teamId: "team_a" });

  const synced = await syncRun(db, await runRow(db, "run_1"), NOW + FIXTURE_RUN_MS);

  assert.equal(synced.status, "failed");
  assert.equal(await attemptExists(db, "run_1"), true);
  assert.equal(synced.refundedAt, null);
  // `consumedAttempt` is documented as the authoritative answer to "did this
  // cost an attempt" and FailureCard.tsx renders it as one line. Leaving it
  // false would put "No official attempt was consumed" directly above text
  // saying the opposite.
  assert.equal(synced.failureConsumedAttempt, true);
  assert.match(synced.failureDetail ?? "", /so this one stays spent/);
  assert.match(synced.failureDetail ?? "", /instructor/);
  // The runner's own account of what broke is the only surviving text about
  // this run (an official run keeps no log), and it is what the team brings to
  // the instructor, so the notice is added to it rather than over it.
  assert.match(synced.failureDetail ?? "", /cogworks\.submissions\.v2/);
});

test("the fixture path leaves a team's other benchmark alone at the cap", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_a", teamId: "team_a", benchmarkId: AUDIO });

  const synced = await syncRun(db, await runRow(db, "run_a"), NOW + FIXTURE_RUN_MS);

  assert.equal(await attemptExists(db, "run_a"), false);
  assert.equal(synced.failureConsumedAttempt, false);
  assert.doesNotMatch(synced.failureDetail ?? "", /stays spent/);
});

test("a failure that is the team's own still consumes the attempt", async () => {
  // The cap must not become a second way to lose an attempt for a run that was
  // always going to cost one. `heavy-model` times out during evaluation, which
  // is on the team.
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await claimedRun(db, { id: "run_1", teamId: "team_a", branch: "heavy-model" });

  const synced = await syncRun(db, await runRow(db, "run_1"), NOW + FIXTURE_RUN_MS);

  assert.equal(synced.failureCategory, "timeout");
  assert.equal(synced.failureConsumedAttempt, true);
  assert.equal(await attemptExists(db, "run_1"), true);
  assert.equal(synced.refundedAt, null);
  assert.doesNotMatch(synced.failureDetail ?? "", /stays spent/);
});

// ---------------------------------------------------------------------------
// The stale-run reaper (execution/maintenance.ts)
// ---------------------------------------------------------------------------

/**
 * The reaper is a cron entry point, not a function of a database. It takes the
 * whole worker Env, of which it reads the D1 binding, the stale threshold, and
 * the Discord token. Without a token deliverTeamNudges returns before doing
 * anything, so nothing here reaches the network.
 */
function maintenanceEnv(binding: unknown) {
  return { DB: binding, RUN_STALE_AFTER_SECONDS: "900" } as never;
}

const STALE_AFTER_MS = 900 * 1_000;

test("the reaper refunds a stalled official run below the cap", async () => {
  const { db, binding } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP - 1);
  await claimedRun(db, {
    id: "run_1",
    teamId: "team_a",
    provider: "modal",
    status: "queued",
    createdAt: NOW - STALE_AFTER_MS - 1,
  });

  await maintainPlatform(maintenanceEnv(binding), NOW);

  const row = await runRow(db, "run_1");
  assert.equal(row.status, "failed");
  assert.equal(row.failureCategory, "provider");
  assert.equal(await attemptExists(db, "run_1"), false);
  assert.equal(row.refundedAt, NOW);
  assert.match(row.failureDetail ?? "", /This attempt was refunded/);
});

test("the reaper at the cap keeps the attempt and explains it", async () => {
  // This path is the easiest refund on the platform to provoke on purpose: it
  // fires on wall-clock alone, with no evidence about whose fault the stall
  // was. A cap in sync.ts alone would leave it wide open.
  const { db, binding } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, {
    id: "run_1",
    teamId: "team_a",
    provider: "modal",
    status: "queued",
    createdAt: NOW - STALE_AFTER_MS - 1,
  });

  await maintainPlatform(maintenanceEnv(binding), NOW);

  const row = await runRow(db, "run_1");
  assert.equal(row.status, "failed");
  assert.equal(await attemptExists(db, "run_1"), true);
  assert.equal(row.refundedAt, null);
  assert.equal(row.failureConsumedAttempt, true);
  assert.match(row.failureDetail ?? "", /so this one stays spent/);
  assert.match(row.failureDetail ?? "", /instructor/);
  // The old copy promised a refund unconditionally, which the cap makes false.
  assert.doesNotMatch(row.failureDetail ?? "", /This attempt was refunded/);
});

test("the reaper counts the cap per benchmark, like the other paths", async () => {
  const { db, binding } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, {
    id: "run_a",
    teamId: "team_a",
    benchmarkId: AUDIO,
    provider: "modal",
    status: "queued",
    createdAt: NOW - STALE_AFTER_MS - 1,
  });

  await maintainPlatform(maintenanceEnv(binding), NOW);

  assert.equal(await attemptExists(db, "run_a"), false);
  assert.equal((await runRow(db, "run_a")).refundedAt, NOW);
});

test("a second cron tick does not refund the same run twice", async () => {
  // The reaper re-selects any failed run whose detail still reads as unsettled.
  // If a refunded run stayed in that selector it would spend a fresh refund
  // against the team's cap every five minutes.
  const { db, binding } = freshDb();
  await seedTeams(db, ["team_a"]);
  await claimedRun(db, {
    id: "run_1",
    teamId: "team_a",
    provider: "modal",
    status: "queued",
    createdAt: NOW - STALE_AFTER_MS - 1,
  });

  await maintainPlatform(maintenanceEnv(binding), NOW);
  await maintainPlatform(maintenanceEnv(binding), NOW + 300_000);

  assert.equal((await runRow(db, "run_1")).refundedAt, NOW);
  assert.equal(await refundCount(db, "team_a", VISION), 1);
});

// ---------------------------------------------------------------------------
// What a capped team reads
// ---------------------------------------------------------------------------

test("the cap message names the count, the outcome, and one next step", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_1", teamId: "team_a" });
  const detail = (await syncRun(db, await runRow(db, "run_1"), NOW + FIXTURE_RUN_MS))
    .failureDetail!;

  // The number comes from REFUND_CAP, so the sentence cannot drift away from
  // the rule it describes.
  assert.match(detail, new RegExp(`all ${REFUND_CAP} refunds available`));
  assert.match(detail, /Bring the run to an instructor/);
});

test("the cap message follows docs/design/voice.md", async () => {
  const { db } = freshDb();
  await seedTeams(db, ["team_a"]);
  await priorRefunds(db, "team_a", VISION, REFUND_CAP);
  await claimedRun(db, { id: "run_1", teamId: "team_a" });
  const detail = (await syncRun(db, await runRow(db, "run_1"), NOW + FIXTURE_RUN_MS))
    .failureDetail!;

  // Portal copy keeps to commas and parentheses; the em dash is the most
  // recognizable AI tell and the voice doc rules it out by name.
  assert.doesNotMatch(detail, /[—–]/u);
  assert.doesNotMatch(detail, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(detail, /!/);
  // No accusation. We do not know that the team caused this, and a message
  // that assumes they did is wrong about the case it exists for.
  assert.doesNotMatch(detail, /abus|exploit|你|farm|gaming|violat|misus/i);
  // Why before what: the notice opens with how refunds normally work and only
  // then says this one does not, rather than leading with the refusal.
  const notice = detail.slice(detail.indexOf("A run that fails"));
  assert.ok(notice.startsWith("A run that fails on our side normally gives the attempt back."));
  assert.ok(notice.indexOf("normally gives") < notice.indexOf("stays spent"));
});

// ---------------------------------------------------------------------------
// The constant
// ---------------------------------------------------------------------------

test("the cap leaves room above the three official attempts", async () => {
  // The reason for 5, restated where it can fail. A team can lose and regain
  // every one of their three attempts to real infrastructure trouble and still
  // have refunds left. Nothing here is calibrated: no refund was ever recorded
  // before migration 0029, so there is no history to calibrate against.
  const { OFFICIAL_LIMIT } = await import("@cogworks/contracts/schema");
  assert.ok(REFUND_CAP > OFFICIAL_LIMIT);
});
