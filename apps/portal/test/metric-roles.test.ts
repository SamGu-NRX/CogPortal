import assert from "node:assert/strict";
import { test } from "node:test";
import { MetricSchema } from "@cogworks/contracts/schema";

/**
 * What the run page does with a number depends on what kind of number it is,
 * and the benchmark is the only thing that knows.
 *
 * Every metric used to render as one row with an arrow saying which
 * direction is better. That arrow is an assertion about the submission, and
 * it is false on three of the five kinds Week 3 publishes. A floor is a
 * property of the dataset, so "higher is better" on it is advice to raise a
 * number the student does not control. A probe that is run and deliberately
 * not scored has no direction of better at all: high means the query text
 * was matched rather than its meaning, which is the opposite of good.
 *
 * The rendering rules are asserted here as a pure mapping, because the point
 * is that the page reads `role` and never a metric's name. A benchmark that
 * grows a floor next year gets the right rendering without this file
 * changing.
 */

function parse(input: unknown) {
  return MetricSchema.parse(input);
}

const base = {
  key: "retrieval_mrr",
  label: "Retrieval MRR",
  value: 0.55,
  unit: null,
  higherIsBetter: true,
  primary: false,
  precision: 3,
};

test("a metric that declares no role is scored, as everything was before", () => {
  const metric = parse(base);
  assert.equal(metric.role, undefined);
  assert.equal(metric.relatesTo, undefined);
});

test("a floor names the metric it is the scale of", () => {
  const metric = parse({
    ...base,
    key: "chance_mrr",
    label: "Chance MRR",
    role: "floor",
    relatesTo: "retrieval_mrr",
  });
  assert.equal(metric.role, "floor");
  assert.equal(metric.relatesTo, "retrieval_mrr");
});

test("a reported probe names the score it shadows", () => {
  // The pairing is the whole reading. `retrieval_mrr_verbatim` alone says
  // nothing; next to `retrieval_mrr` it says whether the submission embedded
  // the query or looked it up.
  const metric = parse({
    ...base,
    key: "retrieval_mrr_verbatim",
    label: "Retrieval MRR, caption unchanged (not scored)",
    role: "reported",
    relatesTo: "retrieval_mrr",
  });
  assert.equal(metric.role, "reported");
  assert.equal(metric.relatesTo, "retrieval_mrr");
});

test("the five roles are the ones the page knows how to draw", () => {
  for (const role of ["scored", "floor", "reported", "diagnostic", "plotted"]) {
    assert.doesNotThrow(() => parse({ ...base, role }));
  }
  assert.throws(() => parse({ ...base, role: "footnote" }));
});

test("an older runner that sends no role still parses", () => {
  // Benchmarks predate this field, and a run recorded before it exists is
  // read back by the same schema.
  assert.doesNotThrow(() => parse(base));
  assert.doesNotThrow(() => parse({ ...base, role: null, relatesTo: null }));
});
