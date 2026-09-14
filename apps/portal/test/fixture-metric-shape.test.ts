import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureMetrics } from "../worker/execution/fixture.ts";

/**
 * The preview a student sees before their first real run has to be the same
 * shape as a real one.
 *
 * It did disagree. `search_mrr` was modelled as the mean of four query
 * rungs, which was correct under scorer version retrieval-v3 and wrong under
 * retrieval-v4, where the verbatim rung is reported and not scored. The
 * fixture also omitted `retrieval_mrr_verbatim` entirely, which is the one
 * number this benchmark most wants a reader to look at: a submission that
 * embedded nothing scored a perfect 1.0000 on it.
 *
 * These assert the shape rather than the values. The values are a hash of the
 * run id and are meant to move; what must not move is which numbers appear
 * and how they relate.
 */

function metricsFor(benchmarkId: string) {
  const metrics = fixtureMetrics("run_shape_test", "main", benchmarkId);
  return new Map(metrics.map((metric) => [metric.key, metric]));
}

test("the Week 3 preview reports the two probes that are never scored", () => {
  const metrics = metricsFor("language-search");
  for (const key of ["retrieval_mrr_verbatim", "search_mrr_verbatim"]) {
    const metric = metrics.get(key);
    assert.ok(metric, `${key} is missing from the preview`);
    // The label must distinguish reported probes from scored metrics.
    assert.match(metric.label, /not scored/);
  }
});

test("the Week 3 preview scores three rungs, not four", () => {
  const metrics = metricsFor("language-search");
  const rungs = ["keywords", "truncated", "typo"].map(
    (rung) => metrics.get(`search_mrr_${rung}`)!.value,
  );
  const mean = rungs.reduce((total, value) => total + value, 0) / rungs.length;
  // Four-decimal rounding at each step, so this is an equality within the
  // rounding rather than an exact one.
  assert.ok(
    Math.abs(metrics.get("search_mrr")!.value - mean) < 5e-4,
    `search_mrr ${metrics.get("search_mrr")!.value} is not the mean of the three rewritten rungs ${mean}`,
  );
});

test("the Week 3 preview reports each retrieval rewrite as a diagnostic", () => {
  const metrics = metricsFor("language-search");
  const values = ["keywords", "truncated", "typo"].map((rung) => {
    const metric = metrics.get(`retrieval_mrr_${rung}`);
    assert.ok(metric, `retrieval_mrr_${rung} is missing`);
    assert.equal(metric.role, "diagnostic");
    assert.equal(metric.higherIsBetter, true);
    assert.equal(metric.primary, false);
    return metric.value;
  });
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(Math.abs(metrics.get("retrieval_mrr")!.value - mean) < 5e-5);
});

test("the Week 3 preview keeps the verbatim probe above the scored number", () => {
  // Not a claim about any particular submission: it is what the reference
  // does, because rewriting a query makes it harder on average. A preview
  // that showed them equal would hide the comparison the two exist for.
  const metrics = metricsFor("language-search");
  assert.ok(
    metrics.get("search_mrr_verbatim")!.value > metrics.get("search_mrr")!.value,
  );
  assert.ok(
    metrics.get("retrieval_mrr_verbatim")!.value >= metrics.get("retrieval_mrr")!.value,
  );
});

test("every benchmark's preview names one primary metric", () => {
  for (const benchmarkId of [
    "language-search",
    "audio-identification",
    "vision-clustering",
    "vision-recognition",
  ]) {
    const metrics = fixtureMetrics("run_shape_test", "main", benchmarkId);
    const primary = metrics.filter((metric) => metric.primary);
    assert.equal(primary.length, 1, `${benchmarkId} has ${primary.length} primary metrics`);
  }
});

test("no preview metric carries a value the schema would reject", () => {
  for (const benchmarkId of [
    "language-search",
    "audio-identification",
    "vision-clustering",
    "vision-recognition",
  ]) {
    for (const metric of fixtureMetrics("run_shape_test", "main", benchmarkId)) {
      assert.ok(Number.isFinite(metric.value), `${benchmarkId}.${metric.key} is not finite`);
      assert.ok(metric.label.length > 0, `${benchmarkId}.${metric.key} has no label`);
    }
  }
});
