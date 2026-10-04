import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { LeaderboardSchema } from "@cogworks/contracts/schema";
import { benchmarks, cohorts, leaderboardSelections, runMetrics, runs, teams } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { getFamilyLeaderboardReadModel, getLeaderboardReadModel } from "../worker/services/leaderboard.ts";
import { projectPublicSweep } from "../worker/services/public-sweep.ts";

/**
 * The public board draws a published run's curve only through the Worker's
 * spec for its benchmark, version and scorer (worker/services/public-sweep.ts).
 * These pin what that buys: stored strings never reach the response, a curve
 * that fails any check costs only its own entry, and nothing else about the
 * board (order, ranks, archive redaction) moves.
 */

const STORED_AXIS = "how far the query is from the caption";
const LANGUAGE = { benchmarkId: "language-search", benchmarkVersion: 1, scorerVersion: "retrieval-v4" };
const storedCurve = (points: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ axis: STORED_AXIS, metric: "search_mrr", points, ...extra });
const RUNGS = [
  { x: 0, y: 0.6412, label: "verbatim" },
  { x: 1, y: 0.5733, label: "keywords" },
  { x: 2, y: 0.4021, label: "truncated" },
  { x: 3, y: 0.5104, label: "typo" },
];
/** The run's published metric for each rung, as the plugin computes both from one value. */
const RUNG_METRICS = RUNGS.map((point) => [`search_mrr_${point.label}`, point.y] as const);
const PUBLISHED: ReadonlyMap<string, number> = new Map([["overall", 0.512], ["search_mrr", 0.4953], ...RUNG_METRICS]);
const publishedWith = (changes: Record<string, number | undefined>) => {
  const next = new Map(PUBLISHED);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) next.delete(key);
    else next.set(key, value);
  }
  return next;
};

test("a valid Language curve is renamed from the spec and carries numbers only", () => {
  const sweep = projectPublicSweep(
    { ...LANGUAGE, sweepJson: storedCurve(RUNGS.map((point) => ({ ...point, note: "C:\\Users\\student\\notes.txt" })), { finding: "private" }) },
    PUBLISHED,
  );
  assert.deepEqual(sweep, {
    axis: "query variant",
    metric: "Search MRR",
    ticks: [
      { x: 0, label: "caption unchanged" },
      { x: 1, label: "keywords only" },
      { x: 2, label: "first three words" },
      { x: 3, label: "one typo" },
    ],
    points: RUNGS.map(({ x, y }) => ({ x, y })),
    note: "Caption unchanged is reported, not scored; the scored Search MRR averages the other three variants.",
  });
});

test("a curve missing a variant keeps the full axis, so it is not stretched", () => {
  const sweep = projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve([RUNGS[0], RUNGS[1], RUNGS[3]]) }, PUBLISHED);
  assert.deepEqual(sweep?.points.map((point) => point.x), [0, 1, 3]);
  assert.equal(sweep?.ticks.length, 4);
  // A stored point with no label is identified by its x alone.
  assert.ok(projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve(RUNGS.map(({ x, y }) => ({ x, y }))) }, PUBLISHED));
});

for (const [name, run, published] of [
  ["another benchmark", { ...LANGUAGE, benchmarkId: "audio-identification", scorerVersion: "identification-v1" }, PUBLISHED],
  ["another version", { ...LANGUAGE, benchmarkVersion: 2 }, PUBLISHED],
  ["another scorer", { ...LANGUAGE, scorerVersion: "retrieval-v3" }, PUBLISHED],
  ["a run that never published search_mrr", LANGUAGE, publishedWith({ search_mrr: undefined })],
] as const) {
  test(`no spec match means no curve: ${name}`, () => {
    assert.equal(projectPublicSweep({ ...run, sweepJson: storedCurve(RUNGS) }, published), null);
  });
}

for (const [name, sweepJson] of [
  ["no stored curve", null],
  ["unparseable JSON", "{not json"],
  ["a JSON array", "[]"],
  ["a different stored axis", storedCurve(RUNGS, { axis: "songs in the library" })],
  ["a different stored metric", storedCurve(RUNGS, { metric: "overall" })],
  ["points that are not a list", storedCurve("0.5")],
  ["one point", storedCurve([RUNGS[0]])],
  ["more than 24 points", storedCurve(Array.from({ length: 25 }, (_, x) => ({ x, y: 0.5 })))],
  ["a value above 1", storedCurve([RUNGS[0], { ...RUNGS[1], y: 1.01 }])],
  ["a value below 0", storedCurve([RUNGS[0], { ...RUNGS[1], y: -0.01 }])],
  ["a value written as text", storedCurve([RUNGS[0], { ...RUNGS[1], y: "0.57" }])],
  ["a null value", storedCurve([RUNGS[0], { ...RUNGS[1], y: null }])],
  ["an x the benchmark cannot produce", storedCurve([RUNGS[0], { x: 1.5, y: 0.5 }])],
  ["x out of order", storedCurve([RUNGS[1], RUNGS[0]])],
  ["a repeated x", storedCurve([RUNGS[0], RUNGS[0]])],
  ["a stored label that disagrees with the spec", storedCurve([RUNGS[0], { ...RUNGS[1], label: "C:\\Users\\student" }])],
  ["a point that is not an object", storedCurve([RUNGS[0], 0.5])],
] as const) {
  test(`a stored curve with ${name} is withheld`, () => {
    assert.equal(projectPublicSweep({ ...LANGUAGE, sweepJson }, PUBLISHED), null);
  });
}

test("the browser schema drops one malformed curve without failing the board", () => {
  const entry = (teamName: string, publicSweep: unknown) => ({
    rank: 1, teamName, teamDescription: null, provenance: "live", repoUrl: null, sha: "", shortSha: "",
    primaryMetric: { key: "overall", label: "Overall", value: 0.5, unit: null, higherIsBetter: true, primary: true, precision: 4 },
    supportingMetrics: [], completedAt: 1, isYou: false, publicSweep,
  });
  const good = projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve(RUNGS) }, PUBLISHED);
  const board = LeaderboardSchema.parse({
    benchmark: {
      id: "language-search", version: 1, contractVersion: "v2", entryPointName: "language-search", title: "Search",
      module: "language", summary: "s", active: true, pluginVersion: "1", datasetVersion: "d", scorerVersion: "retrieval-v4",
      runtimeVersion: "r",
    },
    entries: [
      entry("good", good),
      entry("bad", { ...good, points: [{ x: 0, y: 7 }] }),
      entry("extra", { ...good, finding: "private" }),
      { ...entry("old", null), publicSweep: undefined },
    ],
  });
  assert.deepEqual(board.entries.map((value) => value.publicSweep === null), [false, true, true, true]);
  assert.deepEqual(board.entries[0]?.publicSweep, good);
});

/* ── Each point against the metric already published for it ─────────────── */

for (const point of RUNGS) {
  test(`a ${point.label} point that disagrees with its published metric withholds the curve`, () => {
    const key = `search_mrr_${point.label}`;
    // A small nonzero difference from the published value still contradicts it.
    const nudged = publishedWith({ [key]: point.y + Number.EPSILON * 8 });
    assert.notEqual(nudged.get(key), point.y);
    assert.equal(projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve(RUNGS) }, nudged), null);
  });
  test(`a ${point.label} point with no published metric withholds the curve`, () => {
    const missing = publishedWith({ [`search_mrr_${point.label}`]: undefined });
    assert.equal(projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve(RUNGS) }, missing), null);
  });
}

test("a published rung metric that is not a finite number corroborates nothing", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve(RUNGS) }, publishedWith({ search_mrr_typo: value })), null);
  }
});

test("a partial curve is drawn when every point it has matches its published metric", () => {
  // No truncated point and no truncated metric: nothing to contradict.
  const partial = projectPublicSweep(
    { ...LANGUAGE, sweepJson: storedCurve([RUNGS[0], RUNGS[1], RUNGS[3]]) },
    publishedWith({ search_mrr_truncated: undefined }),
  );
  assert.deepEqual(partial?.points, [RUNGS[0], RUNGS[1], RUNGS[3]].map(({ x, y }) => ({ x, y })));
  // A metric with no point is not a contradiction either.
  assert.ok(projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve([RUNGS[0], RUNGS[1]]) }, PUBLISHED));
});

test("a curve whose points all match their published metrics is drawn as stored", () => {
  assert.deepEqual(
    projectPublicSweep({ ...LANGUAGE, sweepJson: storedCurve(RUNGS) }, PUBLISHED)?.points,
    RUNGS.map(({ x, y }) => ({ x, y })),
  );
});

/* ── Through the read model ─────────────────────────────────────────────── */

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

const SHA = "71258046e60fecd3295c0b52236fc6e476b0e9cf";
const PRIVATE_NOTE = "embed_text in src/secret_pipeline.py returned None for 40 captions";
const PRIVATE_LABEL = "Students/ada/private-label";

/** Four published Language results, scored best first so wire order is a ranking. */
async function seeded() {
  const binding = freshBinding();
  const env = { DB: binding } as unknown as Env;
  const db = drizzle(binding as never);
  await db.insert(cohorts).values({ id: "cohort_t", slug: "t", name: "Test cohort", joinCode: "JOIN-T", active: true });
  const rows = [
    { id: "team_good", score: 0.6, finishedAt: 100, provenance: "live", sweep: storedCurve(RUNGS) },
    { id: "team_bad", score: 0.5, finishedAt: 300, provenance: "live", sweep: storedCurve([RUNGS[0], { ...RUNGS[1], label: PRIVATE_LABEL }]) },
    { id: "team_none", score: 0.4, finishedAt: 400, provenance: "live", sweep: null },
    { id: "team_archive", score: 0.3, finishedAt: 200, provenance: "archive", sweep: storedCurve(RUNGS) },
  ] as const;
  for (const row of rows) {
    const fullName = `some-student/${row.id}`;
    await db.insert(teams).values({
      id: row.id, cohortId: "cohort_t", name: row.id, repoOwner: "some-student", repoName: row.id,
      repoFullName: fullName, repoUrl: `https://github.com/${fullName}`, defaultBranch: "main", provenance: row.provenance,
    });
    const runId = `run_${row.id}`;
    await db.insert(runs).values({
      id: runId, teamId: row.id, ...LANGUAGE, contractVersion: "cogworks.submissions.v2", mode: "official",
      status: "succeeded", branch: "main", sha: SHA, repositoryFullName: fullName, attemptNumber: 1,
      createdAt: 10, finishedAt: row.finishedAt, sweepJson: row.sweep, diagnosticsJson: JSON.stringify([PRIVATE_NOTE]),
      log: PRIVATE_NOTE,
    });
    for (const [key, value] of [["overall", row.score], ["search_mrr", 0.5], ...RUNG_METRICS] as const) {
      await db.insert(runMetrics).values({
        runId, key, label: key, value, higherIsBetter: true, isPrimary: key === "overall", precision: 4, role: "scored",
      });
    }
    await db.insert(leaderboardSelections).values({
      teamId: row.id, benchmarkId: "language-search", benchmarkVersion: 1, runId, selectedAt: row.finishedAt,
    });
  }
  return env;
}

test("one team's malformed curve cannot erase another team's", async () => {
  const env = await seeded();
  const board = await getLeaderboardReadModel(env, "language-search");
  const byTeam = new Map(board.entries.map((entry) => [entry.teamName, entry]));
  assert.equal(byTeam.get("team_bad")?.publicSweep, null);
  assert.equal(byTeam.get("team_none")?.publicSweep, null);
  assert.deepEqual(byTeam.get("team_good")?.publicSweep?.points, RUNGS.map(({ x, y }) => ({ x, y })));
  // Every entry is still on the board; a bad curve never removes a result.
  assert.equal(board.entries.length, 4);
});

test("the API keeps the read model's order and ranks; only the page reorders", async () => {
  const env = await seeded();
  const board = await getLeaderboardReadModel(env, "language-search");
  assert.deepEqual(
    board.entries.map((entry) => [entry.rank, entry.teamName]),
    [[1, "team_good"], [2, "team_bad"], [3, "team_none"], [4, "team_archive"]],
  );
});

test("no stored string, note or log reaches the public response", async () => {
  const env = await seeded();
  const body = JSON.stringify(await getLeaderboardReadModel(env, "language-search"));
  assert.doesNotMatch(body, /secret_pipeline|Students\/ada/);
  assert.ok(!body.includes(STORED_AXIS), "the stored axis text was forwarded");
  assert.doesNotMatch(body, /diagnostics|"log"|sweepJson|runId|run_team/);
});

test("an archive row gets its curve and still withholds its repository and commit", async () => {
  const env = await seeded();
  const board = await getLeaderboardReadModel(env, "language-search");
  const archive = board.entries.find((entry) => entry.provenance === "archive");
  assert.ok(archive?.publicSweep, "the archive curve is drawn");
  assert.equal(archive.repoUrl, null);
  assert.equal(archive.sha, "");
  const body = JSON.stringify(archive);
  assert.doesNotMatch(body, /github\.com|some-student|[0-9a-f]{40}/);
});

test("a run whose stored curve is later edited loses only its own curve", async () => {
  const env = await seeded();
  await drizzle(env.DB).update(runs).set({ sweepJson: storedCurve([{ x: 0, y: Number.MAX_VALUE }]) }).where(eq(runs.id, "run_team_good"));
  const board = await getLeaderboardReadModel(env, "language-search");
  assert.equal(board.entries.find((entry) => entry.teamName === "team_good")?.publicSweep, null);
  assert.ok(board.entries.find((entry) => entry.teamName === "team_archive")?.publicSweep);
});

test("the Vision Overall family never carries a curve, even over runs that stored one", async () => {
  const env = await seeded();
  const db = drizzle(env.DB);
  const components = [
    { id: "run_rec", benchmarkId: "vision-recognition", scorerVersion: "recognition-v2", metrics: ["recognition_score", "known_identification", "unknown_lifecycle"] },
    { id: "run_clu", benchmarkId: "vision-clustering", scorerVersion: "clustering-v2", metrics: ["clustering_pairwise_f1"] },
  ];
  for (const component of components) {
    await db.insert(runs).values({
      id: component.id, teamId: "team_good", benchmarkId: component.benchmarkId, benchmarkVersion: 2,
      scorerVersion: component.scorerVersion, contractVersion: "cogworks.submissions.v2", mode: "official",
      status: "succeeded", branch: "main", sha: SHA, repositoryId: 42, repositoryFullName: "some-student/team_good",
      attemptNumber: 1, createdAt: 10, finishedAt: 50, sweepJson: storedCurve(RUNGS),
    });
    for (const key of component.metrics) {
      await db.insert(runMetrics).values({
        runId: component.id, key, label: key, value: 0.7, higherIsBetter: true, isPrimary: key === component.metrics[0], precision: 3, role: "scored",
      });
    }
    await db.insert(leaderboardSelections).values({
      teamId: "team_good", benchmarkId: component.benchmarkId, benchmarkVersion: 2, runId: component.id, selectedAt: 60,
    });
  }
  const family = await getFamilyLeaderboardReadModel(env, "vision-overall");
  assert.deepEqual(family.entries.map((entry) => [entry.teamName, entry.publicSweep]), [["team_good", null]]);
  // The components' own boards have no spec either, so no curve there.
  const recognition = await getLeaderboardReadModel(env, "vision-recognition");
  assert.deepEqual(recognition.entries.map((entry) => entry.publicSweep), [null]);
});

test("the family names each component's scorer from the catalog that filters it, even with no entries", async () => {
  const env = await seeded();
  const scorers = async () =>
    (await getFamilyLeaderboardReadModel(env, "vision-overall")).family.components.map((component) => [component.benchmarkId, component.scorerVersion]);
  const empty = await getFamilyLeaderboardReadModel(env, "vision-overall");
  assert.equal(empty.entries.length, 0);
  assert.deepEqual(await scorers(), [
    ["vision-recognition", "recognition-v2"],
    ["vision-recognition", "recognition-v2"],
    ["vision-clustering", "clustering-v2"],
  ]);
  // Read from the catalog, not written into the read model: a catalog edit moves it.
  await drizzle(env.DB).update(benchmarks).set({ scorerVersion: "clustering-v9" })
    .where(and(eq(benchmarks.id, "vision-clustering"), eq(benchmarks.version, 2)));
  assert.deepEqual((await scorers())[2], ["vision-clustering", "clustering-v9"]);
});

test("a curve that contradicts its run's published metric is withheld for that entry alone", async () => {
  const env = await seeded();
  await drizzle(env.DB).update(runMetrics).set({ value: 0.9 })
    .where(and(eq(runMetrics.runId, "run_team_good"), eq(runMetrics.key, "search_mrr_keywords")));
  const board = await getLeaderboardReadModel(env, "language-search");
  const good = board.entries.find((entry) => entry.teamName === "team_good");
  assert.equal(good?.publicSweep, null);
  // The published numbers themselves stay, including the one that disagreed.
  assert.equal(good?.supportingMetrics.find((metric) => metric.key === "search_mrr_keywords")?.value, 0.9);
  assert.equal(good?.primaryMetric.value, 0.6);
  // A neighbour's coherent curve is untouched, and so is every entry's place.
  assert.deepEqual(board.entries.find((entry) => entry.teamName === "team_archive")?.publicSweep?.points, RUNGS.map(({ x, y }) => ({ x, y })));
  assert.deepEqual(board.entries.map((entry) => [entry.rank, entry.teamName]), [[1, "team_good"], [2, "team_bad"], [3, "team_none"], [4, "team_archive"]]);
});
