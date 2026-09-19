import assert from "node:assert/strict";
import { test } from "node:test";
import { BenchmarkResultV1Schema, SweepSchema } from "@cogworks/contracts/protocol";
import { RunDetailSchema } from "@cogworks/contracts/schema";

/**
 * The sweep crosses four boundaries between the sandbox and the browser: the
 * runner's result payload, the callback route, a JSON column in D1, and the
 * detail serializer. A shape that validates at one hop and not the next shows
 * up as a blank panel or a render crash rather than as an error anyone sees,
 * which is the class of loss this platform has already been bitten by.
 */

const SWEEP = {
  axis: "songs in the library",
  metric: "identification_score",
  points: [
    { x: 5, y: 0.6 },
    { x: 30, y: 0.52 },
  ],
};

const RESULT = {
  protocolVersion: "1" as const,
  benchmarkId: "audio-identification",
  benchmarkVersion: 1,
  metrics: [
    {
      key: "identification_score",
      label: "Identification score",
      value: 0.52,
      unit: null,
      higherIsBetter: true,
      primary: true,
      precision: 3,
    },
  ],
  diagnostics: ["Identification holds steady from 5 songs to 30."],
  outputDigest: "a".repeat(64),
  weightsSupplied: [],
};

test("the runner may send a sweep", () => {
  assert.equal(BenchmarkResultV1Schema.safeParse({ ...RESULT, sweep: SWEEP }).success, true);
});

test("a benchmark with no difficulty knob sends none", () => {
  // Weeks 2 and 3 have no sweep today, and a required field would fail every
  // one of their runs at the callback.
  assert.equal(BenchmarkResultV1Schema.safeParse(RESULT).success, true);
});

test("what the runner sends is what the browser accepts", () => {
  // The two schemas are written separately on purpose, so this is the only
  // thing holding them together.
  assert.equal(RunDetailSchema.shape.sweep.safeParse(SWEEP).success, true);
});

test("a run scored before the column existed serves null", () => {
  assert.equal(RunDetailSchema.shape.sweep.safeParse(null).success, true);
});

test("a malformed stored sweep is rejected rather than rendered", () => {
  // The serializer parses stored JSON through this schema instead of trusting
  // it, so a shape change costs the curve and never the page.
  assert.equal(RunDetailSchema.shape.sweep.safeParse({ axis: "x" }).success, false);
  assert.equal(RunDetailSchema.shape.sweep.safeParse({ axis: "x", metric: "y", points: "no" }).success, false);
});

test("a rung curve carries the name of each rung, not just its position", () => {
  // Week 3's sweep x is an ordering (the four query rewrites, from the
  // caption unchanged to the furthest), so 0 through 3 say nothing on their
  // own. The schema has always allowed a per-point label; nothing set one
  // until the rung curve needed it, and the trace printed the bare number in
  // the drawing and read it aloud the same way.
  const sweep = SweepSchema.parse({
    metric: "search_mrr",
    axis: "how far the query is from the caption",
    points: [
      { x: 0, y: 0.95, label: "verbatim" },
      { x: 1, y: 0.03, label: "keywords" },
    ],
  });
  assert.equal(sweep.points[0].label, "verbatim");
  assert.equal(sweep.points[1].label, "keywords");
});

test("a sweep whose x is a real quantity still needs no label", () => {
  // Week 1's axis is a count of songs and reads correctly as itself.
  const sweep = SweepSchema.parse({
    metric: "top1",
    axis: "songs in the library",
    points: [
      { x: 10, y: 0.98 },
      { x: 120, y: 0.61 },
    ],
  });
  assert.equal(sweep.points[0].label, undefined);
});
