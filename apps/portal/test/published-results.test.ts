import assert from "node:assert/strict";
import { test } from "node:test";
import type { FamilyLeaderboard, LeaderboardEntry, Metric } from "@cogworks/contracts/schema";
import {
  benchmarkScopeLine,
  familyMakeup,
  familyScopeLine,
  groupMetricsByRole,
  newestFirst,
  readPublicSweep,
} from "../src/lib/published-results.ts";

function metric(key: string, role: Metric["role"], value = 0.5): Metric {
  return { key, label: key, value, unit: null, higherIsBetter: true, primary: false, precision: 3, help: null, role, relatesTo: null };
}

function entry(teamName: string, completedAt: number, score: number, sha = "a".repeat(40)): LeaderboardEntry {
  return {
    rank: 0, teamName, teamDescription: null, provenance: "live", repoUrl: null, sha, shortSha: sha.slice(0, 7),
    primaryMetric: { ...metric("overall", "scored", score), primary: true }, supportingMetrics: [], completedAt, isYou: false,
  };
}

/** The read model's order: best score first, which is a ranking. */
const BY_SCORE = [
  entry("Lantern Lab", 2_000, 0.51),
  entry("Team Heron", 1_000, 0.48),
  entry("Tidepool", 3_000, 0.44),
];

test("the board reads newest first whatever order the read model sent", () => {
  const names = (list: LeaderboardEntry[]) => list.map((value) => value.teamName);
  assert.deepEqual(names(newestFirst(BY_SCORE)), ["Tidepool", "Lantern Lab", "Team Heron"]);
  assert.deepEqual(names(newestFirst([...BY_SCORE].reverse())), ["Tidepool", "Lantern Lab", "Team Heron"]);
  assert.deepEqual(names(newestFirst([BY_SCORE[1]!, BY_SCORE[2]!, BY_SCORE[0]!])), ["Tidepool", "Lantern Lab", "Team Heron"]);
});

test("ordering leaves the read model's array and ranks alone", () => {
  const wire = BY_SCORE.map((value, index) => ({ ...value, rank: index + 1 }));
  const snapshot = structuredClone(wire);
  newestFirst(wire);
  assert.deepEqual(wire, snapshot);
});

test("results finished in the same millisecond keep one order on every pass", () => {
  const tied = [
    entry("beta", 5_000, 0.9, "b".repeat(40)),
    entry("Alpha", 5_000, 0.1, "c".repeat(40)),
    entry("alpha", 5_000, 0.5, "d".repeat(40)),
    entry("alpha", 5_000, 0.5, "0".repeat(40)),
  ];
  const expected = ["Alpha:c", "alpha:0", "alpha:d", "beta:b"];
  for (const order of [tied, [...tied].reverse(), [tied[2]!, tied[0]!, tied[3]!, tied[1]!]]) {
    assert.deepEqual(newestFirst(order).map((value) => `${value.teamName}:${value.sha[0]}`), expected);
  }
});

test("each measurement lands in exactly one group, named by its role", () => {
  const metrics = [
    metric("chance_mrr", "floor"),
    metric("text_mrr", "scored"),
    metric("median_rank", "diagnostic"),
    metric("verbatim", "reported"),
    metric("typo", "plotted"),
    metric("retrieval_mrr", "scored"),
  ];
  const groups = groupMetricsByRole(metrics);
  assert.deepEqual(
    groups.map((group) => [group.label, group.metrics.map((value) => value.key)]),
    [
      ["Part of the score", ["text_mrr", "retrieval_mrr"]],
      ["Measured, not scored", ["verbatim"]],
      ["Plotted values", ["typo"]],
      ["Floors set by the data", ["chance_mrr"]],
      ["Diagnostics", ["median_rank"]],
    ],
  );
  assert.equal(groups.flatMap((group) => group.metrics).length, metrics.length);
});

test("a measurement with no recorded role is not presented as scored", () => {
  const groups = groupMetricsByRole([metric("text_mrr", null), metric("search_mrr", undefined), metric("retrieval_mrr", "scored")]);
  assert.deepEqual(
    groups.map((group) => [group.role, group.label, group.metrics.map((value) => value.key)]),
    [
      ["scored", "Part of the score", ["retrieval_mrr"]],
      [null, "Role not recorded", ["text_mrr", "search_mrr"]],
    ],
  );
  assert.deepEqual(groupMetricsByRole([]), []);
});

test("the scope line names the exact benchmark version and scorer", () => {
  assert.equal(
    benchmarkScopeLine({ id: "language-search", version: 1, scorerVersion: "retrieval-v4" }),
    "language-search v1 · scorer retrieval-v4 · newest first",
  );
});

const OVERALL: FamilyLeaderboard["family"] = {
  id: "vision-overall", version: 1, title: "Vision Overall", module: "vision", active: true,
  components: [
    { key: "known_identification", label: "Known identification", benchmarkId: "vision-recognition", benchmarkVersion: 2, metricKey: "known_identification", weight: 1 / 3, scorerVersion: "recognition-v2" },
    { key: "unknown_lifecycle", label: "Unknown lifecycle", benchmarkId: "vision-recognition", benchmarkVersion: 2, metricKey: "unknown_lifecycle", weight: 1 / 3, scorerVersion: "recognition-v2" },
    { key: "clustering_pairwise_f1", label: "Clustering pairwise F1", benchmarkId: "vision-clustering", benchmarkVersion: 2, metricKey: "clustering_pairwise_f1", weight: 1 / 3, scorerVersion: "clustering-v2" },
  ],
};

test("a family names each component benchmark once, at its version and scorer", () => {
  assert.equal(
    familyScopeLine(OVERALL),
    "vision-overall v1 · from vision-recognition v2 (scorer recognition-v2) + vision-clustering v2 (scorer clustering-v2) · newest first",
  );
});

test("a component whose scorer is not known says so instead of leaving it out", () => {
  const legacy = { ...OVERALL, components: OVERALL.components.map((component) => ({ ...component, scorerVersion: null })) };
  assert.equal(
    familyScopeLine(legacy),
    "vision-overall v1 · from vision-recognition v2 (scorer unknown) + vision-clustering v2 (scorer unknown) · newest first",
  );
});

test("the family sentence follows the catalog's weights rather than assuming them", () => {
  assert.equal(
    familyMakeup(OVERALL),
    "Vision Overall weights Known identification, Unknown lifecycle and Clustering pairwise F1 equally.",
  );
  const uneven = { ...OVERALL, components: OVERALL.components.map((component, index) => ({ ...component, weight: index === 2 ? 2 : 1 })) };
  assert.equal(
    familyMakeup(uneven),
    "Vision Overall combines Known identification 25%, Unknown lifecycle 25%, Clustering pairwise F1 50%.",
  );
  assert.equal(familyMakeup({ ...OVERALL, components: [] }), "");
});

const TICKS = [
  { x: 0, label: "caption unchanged" },
  { x: 1, label: "keywords only" },
  { x: 2, label: "first three words" },
  { x: 3, label: "one typo" },
];
const curve = (...ys: Array<number | null>) => ({
  axis: "query variant", metric: "Search MRR", ticks: TICKS,
  points: ys.flatMap((y, x) => (y === null ? [] : [{ x, y }])),
  note: null,
});

test("a curve is read as its lowest and highest values, named by variant", () => {
  assert.equal(
    readPublicSweep(curve(0.6412, 0.5733, 0.4021, 0.5104)),
    "Search MRR by query variant: lowest 0.40 (first three words), highest 0.64 (caption unchanged).",
  );
});

test("the reading names a variant with no curve point rather than skipping it", () => {
  assert.equal(
    readPublicSweep(curve(0.55, 0.52, null, null)),
    "Search MRR by query variant: lowest 0.52 (keywords only), highest 0.55 (caption unchanged). No curve point for first three words, one typo.",
  );
});

test("a flat curve is read as one value, with no fall or rise claimed", () => {
  assert.equal(readPublicSweep(curve(0.5, 0.501, 0.499, 0.5)), "Search MRR by query variant: 0.50 at every point measured.");
  assert.doesNotMatch(readPublicSweep(curve(0.95, 0.03, 0.03, 0.04)), /fall|drop|knee|holds|break/i);
});
