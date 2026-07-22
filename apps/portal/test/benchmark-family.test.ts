import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasSharedBenchmarkSource,
  weightedComponentScore,
} from "../worker/services/benchmark-family.ts";

test("overall requires the same non-null repository and commit", () => {
  assert.equal(
    hasSharedBenchmarkSource([
      { repositoryId: 7, sha: "a".repeat(40) },
      { repositoryId: 7, sha: "a".repeat(40) },
    ]),
    true,
  );
  assert.equal(
    hasSharedBenchmarkSource([
      { repositoryId: 7, sha: "a".repeat(40) },
      { repositoryId: 8, sha: "a".repeat(40) },
    ]),
    false,
  );
  assert.equal(
    hasSharedBenchmarkSource([
      { repositoryId: 7, sha: "a".repeat(40) },
      { repositoryId: 7, sha: "b".repeat(40) },
    ]),
    false,
  );
  assert.equal(
    hasSharedBenchmarkSource([
      { repositoryId: null, sha: "a".repeat(40) },
      { repositoryId: null, sha: "a".repeat(40) },
    ]),
    false,
  );
});

test("overall weights the three student behaviors equally", () => {
  const third = 1 / 3;
  const score = weightedComponentScore([
    { value: 0.9, weight: third },
    { value: 0.6, weight: third },
    { value: 0.3, weight: third },
  ]);
  assert.ok(Math.abs(score - 0.6) < 1e-12);
});
