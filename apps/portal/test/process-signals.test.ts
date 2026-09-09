import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "../worker/db/client.ts";
import { cohorts, runs, teams } from "../worker/db/schema.ts";
import {
  HISTORY_BULK_UPLOAD,
  HISTORY_EMPTY,
  HISTORY_FETCH_FAILED,
  HISTORY_USABLE,
  UNAUTHORIZED_HISTORY_REASON,
  WEEK1_STAGE_MAP,
  boundaryChurn,
  buildProcessSignals,
  classifyHistoryQuality,
  findingSentences,
  ownershipBreadth,
  stageFootprint,
} from "../worker/services/process-signals.ts";
import type {
  BuildProcessSignalsInput,
  ProcessSignals,
  RosterMember,
  RunRecord,
} from "../worker/services/process-signals.ts";
import { fetchCommitHistory, parseCoAuthorTrailers } from "../worker/github/commits.ts";
import type { CommitRecord, FetchCommitsResult } from "../worker/github/commits.ts";
import {
  cacheProcessSignals,
  hasRunsElsewhere,
  resolveWeekLabel,
  scoredRunRecords,
} from "../worker/routes/team.ts";

const DAY = 24 * 60 * 60 * 1_000;
const T0 = Date.parse("2026-06-01T00:00:00Z");

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: "a".repeat(40),
    authorLogin: "ada",
    authoredAt: T0,
    filesChanged: ["src/find_peaks.py"],
    coAuthors: [],
    ...overrides,
  };
}

const NO_ROSTER: RosterMember[] = [];

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { runId: "run_1", createdAt: T0, scored: true, ...overrides };
}

// ---------------------------------------------------------------------------
// The bulk-upload gate
// ---------------------------------------------------------------------------

test("a single-commit history is bulk_upload, not usable", () => {
  const commits = [commit({ sha: "a".repeat(40) })];
  assert.equal(classifyHistoryQuality(commits), HISTORY_BULK_UPLOAD);
});

test("one commit holding most of the changed files across the whole history is bulk_upload", () => {
  const commits = [
    commit({ sha: "a".repeat(40), filesChanged: ["a.py", "b.py", "c.py", "d.py"] }),
    commit({ sha: "b".repeat(40), filesChanged: ["e.py"] }),
  ];
  // 4 of 5 total changed files (80%) sit in one commit -- over the 60% line.
  assert.equal(classifyHistoryQuality(commits), HISTORY_BULK_UPLOAD);
});

test("bulk_upload marks every commit-derived signal unavailable, with a reason", () => {
  const commits = [commit({ sha: "a".repeat(40) })];

  const footprint = stageFootprint(commits, WEEK1_STAGE_MAP, NO_ROSTER);
  for (const stage of Object.keys(WEEK1_STAGE_MAP)) {
    assert.equal(footprint[stage].available, false);
    assert.equal(footprint[stage].commitCount, null);
    assert.equal(footprint[stage].distinctAuthorCount, null);
    assert.match(footprint[stage].unavailableReason ?? "", /single commit/);
  }

  // {}, not per-stage empty arrays -- see ownershipBreadth's own docstring
  // on why that distinction matters.
  assert.deepEqual(ownershipBreadth(commits, WEEK1_STAGE_MAP, NO_ROSTER), {});

  // Boundary churn is also commit-derived and degrades the same way, even
  // when a first-light timestamp exists to measure churn against.
  const boundaryCommits = [commit({ sha: "a".repeat(40), filesChanged: ["submission.py"] })];
  assert.deepEqual(boundaryChurn(boundaryCommits, ["submission.py"], T0 + DAY), []);
});

// ---------------------------------------------------------------------------
// First light is exempt from the bulk-upload gate
// ---------------------------------------------------------------------------

test("first light still reports a scored run even when the commit history is bulk_upload", () => {
  const input: BuildProcessSignalsInput = {
    commitsResult: { ok: true, commits: [commit({ sha: "a".repeat(40) })] },
    runs: [run({ runId: "run_1", createdAt: T0, scored: true })],
    weekLabel: "week1",
    roster: NO_ROSTER,
  };
  const signals = buildProcessSignals(input);

  assert.equal(signals.historyQuality, HISTORY_BULK_UPLOAD);
  // firstLight reads runs (the portal's own observation), never commits, so
  // it is not gated by classifyHistoryQuality the way the other three are.
  assert.equal(signals.firstLight.firstScoredAt, T0);
  assert.equal(signals.firstLight.scoredRunCount, 1);
});

test("first light ignores commit history entirely, including a fetch failure", () => {
  const input: BuildProcessSignalsInput = {
    commitsResult: { ok: false, reason: "fetch_failed" },
    runs: [run({ runId: "run_1", createdAt: T0, scored: true })],
    weekLabel: "week1",
    roster: NO_ROSTER,
  };
  const signals = buildProcessSignals(input);
  assert.equal(signals.historyQuality, HISTORY_FETCH_FAILED);
  assert.equal(signals.firstLight.firstScoredAt, T0);
  assert.equal(signals.firstLight.scoredRunCount, 1);
});

test("a GitHub 401 threads through the signals and is not cacheable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    const commitsResult = await fetchCommitHistory("cogworks/team", "main", "decrypted-token");
    assert.deepEqual(commitsResult, { ok: false, reason: "unauthorized" });

    const signals = buildProcessSignals({
      commitsResult,
      runs: [],
      weekLabel: "week1",
      roster: NO_ROSTER,
    });
    assert.equal(signals.historyQuality, HISTORY_FETCH_FAILED);
    assert.equal(signals.historyFetchFailureReason, "unauthorized");
    assert.equal(findingSentences(signals)[0], UNAUTHORIZED_HISTORY_REASON);
    for (const activity of Object.values(signals.stageFootprint)) {
      assert.equal(activity.unavailableReason, UNAUTHORIZED_HISTORY_REASON);
    }
    let cacheWrites = 0;
    await cacheProcessSignals(commitsResult, async () => {
      cacheWrites += 1;
    });
    assert.equal(cacheWrites, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Boundary churn only counts after first light
// ---------------------------------------------------------------------------

test("a boundary-file commit before first light is ordinary design work, not churn", () => {
  const commits = [
    commit({ sha: "a".repeat(40), authoredAt: T0, filesChanged: ["submission.py"] }),
    commit({ sha: "b".repeat(40), authoredAt: T0 + 2 * DAY, filesChanged: ["submission.py"] }),
  ];
  const events = boundaryChurn(commits, ["submission.py"], T0 + DAY);
  assert.equal(events.length, 1);
  assert.equal(events[0].sha, "b".repeat(40));
});

test("no first light means nothing counts as churn, even with boundary-file commits", () => {
  const commits = [commit({ sha: "a".repeat(40), authoredAt: T0, filesChanged: ["submission.py"] })];
  assert.deepEqual(boundaryChurn(commits, ["submission.py"], null), []);
});

// ---------------------------------------------------------------------------
// Co-authored commits
// ---------------------------------------------------------------------------

test("a Co-authored-by trailer is read off the commit message", () => {
  const trailers = parseCoAuthorTrailers(
    [
      "Wire the query stage to the database",
      "",
      "Co-Authored-By: Grace Hopper <9+grace@users.noreply.github.com>",
      "co-authored-by: Ada <ada@dev.local>",
      "Signed-off-by: Someone <someone@example.com>",
    ].join("\n"),
  );
  assert.deepEqual(trailers, [
    { name: "Grace Hopper", email: "9+grace@users.noreply.github.com" },
    { name: "Ada", email: "ada@dev.local" },
  ]);
});

test("a co-author on the roster is counted, and one who isn't counts nobody", () => {
  const roster: RosterMember[] = [{ login: "grace", email: "grace@dev.local" }];
  const commits = [
    // The whole point: `authorLogin` is a teammate's machine, and the person
    // who did the work is named only in the trailer.
    commit({
      sha: "a".repeat(40),
      authorLogin: "shared-laptop",
      authoredAt: T0,
      filesChanged: ["find_peaks.py"],
      coAuthors: [
        { name: "Grace Hopper", email: "9+grace@users.noreply.github.com" },
        { name: "Claude", email: "noreply@anthropic.com" },
      ],
    }),
    commit({ sha: "b".repeat(40), authorLogin: "shared-laptop", authoredAt: T0 + DAY }),
  ];

  const owners = ownershipBreadth(commits, WEEK1_STAGE_MAP, roster);
  assert.deepEqual(owners.peaks, ["grace", "shared-laptop"]);
  assert.equal(stageFootprint(commits, WEEK1_STAGE_MAP, roster).peaks.distinctAuthorCount, 2);

  // With no roster to check against, the same trailers resolve to nobody.
  assert.deepEqual(ownershipBreadth(commits, WEEK1_STAGE_MAP, NO_ROSTER).peaks, [
    "shared-laptop",
  ]);
});

test("a trailer resolves by stored email or by a bare roster login", () => {
  const roster: RosterMember[] = [
    { login: "grace", email: "grace@dev.local" },
    { login: "ada", email: "ada@example.edu" },
  ];
  const commits = [
    commit({
      sha: "a".repeat(40),
      authorLogin: "shared-laptop",
      filesChanged: ["find_peaks.py"],
      coAuthors: [
        { name: "A. Lovelace", email: "ADA@example.edu" },
        { name: "Grace", email: "grace@personal.example" },
      ],
    }),
    commit({ sha: "b".repeat(40), authorLogin: "shared-laptop", authoredAt: T0 + DAY }),
  ];

  // Both resolve, and both come back spelled the way the roster spells them.
  assert.deepEqual(ownershipBreadth(commits, WEEK1_STAGE_MAP, roster).peaks, [
    "ada",
    "grace",
    "shared-laptop",
  ]);
});

// ---------------------------------------------------------------------------
// No per-person fields, anywhere in the output, recursively
// ---------------------------------------------------------------------------

/**
 * TS has no runtime type introspection the way Python's `dataclasses.fields()`
 * does, so the guardrail moves one layer down: build a real, populated
 * `ProcessSignals` (via the same orchestration path a request handles) and
 * walk every key of the JSON it would actually serialize to. A future field
 * like `commitsByAuthor` or `lineCount` fails this test the moment it's
 * added, before it ever reaches a route response. Mirrors
 * python/cogbench/tests/test_process.py's `NoPerPersonTotals`, adapted from
 * dataclass field names to camelCase JSON keys.
 */
const FORBIDDEN_KEY_SUBSTRINGS = [
  "byauthor",
  "perauthor",
  "authorcommit",
  "commitsby",
  "authorcount", // distinctAuthorCount is a stage-wide bus-factor count, not
  // a per-author count -- excluded explicitly below, not by loosening this.
  "lines",
  "linecount",
  "insertions",
  "deletions",
];
const ALLOWED_KEY_EXCEPTIONS = new Set(["distinctAuthorCount"]);

function collectKeys(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
}

test("no output key, anywhere in the tree, is a per-person total or a line count", () => {
  const richSignals: ProcessSignals = buildProcessSignals({
    commitsResult: {
      ok: true,
      commits: [
        commit({ sha: "a".repeat(40), authorLogin: "grace", authoredAt: T0, filesChanged: ["find_peaks.py"] }),
        commit({
          sha: "b".repeat(40),
          authorLogin: "ada",
          authoredAt: T0 + DAY,
          filesChanged: ["find_peaks.py", "submission.py"],
        }),
        commit({
          sha: "c".repeat(40),
          authorLogin: "hedy",
          authoredAt: T0 + 3 * DAY,
          filesChanged: ["database.py", "submission.py"],
          // A resolved co-author is in the fixture so the walk covers the
          // authorship path that reads trailers, not only the one that
          // reads the author field.
          coAuthors: [{ name: "Grace Hopper", email: "9+grace@users.noreply.github.com" }],
        }),
      ],
    },
    runs: [run({ runId: "run_1", createdAt: T0 + 2 * DAY, scored: true })],
    weekLabel: "week1",
    roster: [
      { login: "grace", email: "grace@dev.local" },
      { login: "ada", email: "ada@dev.local" },
      { login: "hedy", email: "hedy@dev.local" },
    ],
  });
  const payload = { ...richSignals, findingSentences: findingSentences(richSignals), computedAt: Date.now() };

  const keys: string[] = [];
  collectKeys(payload, keys);
  assert.ok(keys.length > 10, "fixture should exercise a real, populated shape");

  const offenders = keys.filter((key) => {
    if (ALLOWED_KEY_EXCEPTIONS.has(key)) return false;
    const lowered = key.toLowerCase();
    return FORBIDDEN_KEY_SUBSTRINGS.some((pattern) => lowered.includes(pattern));
  });
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Empty history and a failed fetch stay distinct
// ---------------------------------------------------------------------------

test("an empty repository and a fetch failure never produce the same historyQuality", () => {
  assert.equal(classifyHistoryQuality([]), HISTORY_EMPTY);

  const emptyResult: FetchCommitsResult = { ok: true, commits: [] };
  const failedResult: FetchCommitsResult = { ok: false, reason: "fetch_failed" };

  const emptySignals = buildProcessSignals({ commitsResult: emptyResult, runs: [], weekLabel: null, roster: NO_ROSTER });
  const failedSignals = buildProcessSignals({ commitsResult: failedResult, runs: [], weekLabel: null, roster: NO_ROSTER });

  assert.equal(emptySignals.historyQuality, HISTORY_EMPTY);
  assert.equal(failedSignals.historyQuality, HISTORY_FETCH_FAILED);
  assert.notEqual(emptySignals.historyQuality, failedSignals.historyQuality);
});

test("an empty repository and a fetch failure read differently in the finding sentences", () => {
  const emptySignals = buildProcessSignals({
    commitsResult: { ok: true, commits: [] },
    runs: [],
    weekLabel: null,
    roster: NO_ROSTER,
  });
  const failedSignals = buildProcessSignals({
    commitsResult: { ok: false, reason: "fetch_failed" },
    runs: [],
    weekLabel: null,
    roster: NO_ROSTER,
  });

  const emptySentence = findingSentences(emptySignals)[0];
  const failedSentence = findingSentences(failedSignals)[0];

  assert.match(emptySentence, /no commit history yet/i);
  assert.match(failedSentence, /could not be read from GitHub/i);
  assert.notEqual(emptySentence, failedSentence);
});

// ---------------------------------------------------------------------------
// The finding list cannot grow with the repository
// ---------------------------------------------------------------------------

/**
 * The first version emitted one sentence per contract file and one per stage,
 * which on a real week-2 team was seven near-identical lines above a stage
 * list that repeated them. Each group is now one sentence naming every stage
 * or counting every commit it covers, so the only way the list grows is if
 * someone adds a new kind of finding -- and `MAX_FINDING_SENTENCES` caps that
 * too. This pins the shape, not the prose.
 */
test("every group of findings is one sentence, however many stages or files it covers", () => {
  const signals = buildProcessSignals({
    commitsResult: {
      ok: true,
      commits: [
        // `peaks` gets two authors, `database` gets one, and `spectrogram`,
        // `fanout`, and `query` get none.
        commit({ sha: "a".repeat(40), authorLogin: "grace", authoredAt: T0, filesChanged: ["find_peaks.py"] }),
        commit({ sha: "b".repeat(40), authorLogin: "ada", authoredAt: T0 + DAY, filesChanged: ["find_peaks.py"] }),
        commit({ sha: "c".repeat(40), authorLogin: "hedy", authoredAt: T0 + 2 * DAY, filesChanged: ["database.py"] }),
        // Two commits, two contract files each, all after the scored run.
        commit({
          sha: "d".repeat(40),
          authorLogin: "ada",
          authoredAt: T0 + 4 * DAY,
          filesChanged: ["submission.py", "src/benchmark_adapter.py"],
        }),
        commit({
          sha: "e".repeat(40),
          authorLogin: "grace",
          authoredAt: T0 + 5 * DAY,
          filesChanged: ["submission.py", "src/benchmark_adapter.py"],
        }),
      ],
    },
    runs: [run({ runId: "run_1", createdAt: T0 + 3 * DAY, scored: true })],
    weekLabel: "week1",
    roster: NO_ROSTER,
  });

  const sentences = findingSentences(signals);
  assert.equal(sentences.length, 4, `expected four findings, got ${sentences.length}`);

  const [firstRun, churn, untouched, solo] = sentences;
  assert.match(firstRun, /first scored end to end on 2026-06-04/);
  // Two commits touched four boundary paths between them; one sentence.
  assert.match(churn, /^2 commits have changed the files the benchmark calls/);
  // Three stages have no commits; one sentence naming all three.
  assert.match(untouched, /the fanout, query, or spectrogram stages/);
  // One stage has a single author; still one sentence.
  assert.match(solo, /Only one person has committed to the database stage/);

  // And no sentence anywhere names a person or counts their work.
  for (const sentence of sentences) {
    for (const login of ["grace", "ada", "hedy"]) {
      assert.ok(!sentence.includes(login), `finding named a person: ${sentence}`);
    }
  }
});

test("classifyHistoryQuality never returns fetch_failed -- only buildProcessSignals can", () => {
  // A pure sanity check on the module docstring's own claim: process.py has
  // no notion of a fetch failing, so the 3-state pure port must not either.
  assert.equal(classifyHistoryQuality([]), HISTORY_EMPTY);
  assert.equal(classifyHistoryQuality([commit()]), HISTORY_BULK_UPLOAD);
  assert.equal(
    classifyHistoryQuality([
      commit({ sha: "a".repeat(40), filesChanged: ["a.py"] }),
      commit({ sha: "b".repeat(40), filesChanged: ["b.py"] }),
    ]),
    HISTORY_USABLE,
  );
});

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
  return { prepare };
}


test("a repository switch drops the old repository's runs, and says so", async () => {
  const db = drizzle(freshBinding() as never) as unknown as Database;
  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test", joinCode: "TEST", active: true,
  });
  await db.insert(teams).values({
    id: "team_test", cohortId: "cohort_test", name: "Test team",
    repoOwner: "course", repoName: "project", repoFullName: "course/project",
    repoUrl: "https://github.com/course/project", defaultBranch: "main", repoId: 111,
  });
  for (const [id, repositoryId, createdAt] of [
    ["old", 111, 20], ["untracked", null, 10],
  ] as const) {
    await db.insert(runs).values({
      id, teamId: "team_test", repositoryId,
      benchmarkId: "audio-identification", benchmarkVersion: 1,
      contractVersion: "cogworks.submissions.v2", mode: "practice", status: "succeeded",
      branch: "main", sha: "a".repeat(40), attemptNumber: 1,
      createdAt, finishedAt: createdAt + 1, provider: "fixture",
    });
  }
  assert.equal(await resolveWeekLabel(db, "team_test", 111), "week1");
  assert.deepEqual(await scoredRunRecords(db, "team_test", 111), [
    { runId: "old", createdAt: 21, scored: true },
  ]);

  await db.update(teams).set({ repoId: 222 }).where(eq(teams.id, "team_test"));
  const [team] = await db.select().from(teams).where(eq(teams.id, "team_test"));
  const weekLabel = await resolveWeekLabel(db, team.id, team.repoId);
  const runRecords = await scoredRunRecords(db, team.id, team.repoId);
  const runsElsewhere = await hasRunsElsewhere(db, team.id, team.repoId);
  assert.equal(weekLabel, null, "no run speaks for the repository connected now");
  assert.deepEqual(runRecords, []);
  assert.equal(runsElsewhere, true);

  // The whole point: not "you have never scored", which reads as the portal
  // losing their work. Both the run on 111 and the untracked one are real
  // scored runs; neither is evidence for 222.
  const signals = buildProcessSignals({
    commitsResult: { ok: true, commits: [] }, runs: runRecords, weekLabel,
    roster: [], runsElsewhere,
  });
  const said = findingSentences(signals).join(" ");
  assert.match(said, /aren't tied to the repository that's connected now/);
  assert.doesNotMatch(said, /No run has scored end to end yet/);
});

test("a team that really has never scored still hears the integration sentence", async () => {
  const db = drizzle(freshBinding() as never) as unknown as Database;
  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test", joinCode: "TEST", active: true,
  });
  await db.insert(teams).values({
    id: "team_test", cohortId: "cohort_test", name: "Test team",
    repoOwner: "course", repoName: "project", repoFullName: "course/project",
    repoUrl: "https://github.com/course/project", defaultBranch: "main", repoId: 111,
  });
  assert.equal(await hasRunsElsewhere(db, "team_test", 111), false);
  const signals = buildProcessSignals({
    commitsResult: { ok: true, commits: [] }, runs: [], weekLabel: null,
    roster: [], runsElsewhere: false,
  });
  assert.match(findingSentences(signals).join(" "), /No run has scored end to end yet/);
});

test("a run for another repository never speaks for the connected one", async () => {
  const db = drizzle(freshBinding() as never) as unknown as Database;
  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test", joinCode: "TEST", active: true,
  });
  await db.insert(teams).values({
    id: "team_test", cohortId: "cohort_test", name: "Test team",
    repoOwner: "course", repoName: "project", repoFullName: "course/project",
    repoUrl: "https://github.com/course/project", defaultBranch: "main", repoId: 222,
  });
  // One week1 run, and it belongs to the repository the team left.
  await db.insert(runs).values({
    id: "on_the_old_repo", teamId: "team_test", repositoryId: 111,
    benchmarkId: "audio-identification", benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v2", mode: "practice", status: "succeeded",
    branch: "main", sha: "a".repeat(40), attemptNumber: 1,
    createdAt: 20, finishedAt: 21, provider: "fixture",
  });

  assert.equal(await resolveWeekLabel(db, "team_test", 222), null);
  assert.deepEqual(await scoredRunRecords(db, "team_test", 222), []);
});
