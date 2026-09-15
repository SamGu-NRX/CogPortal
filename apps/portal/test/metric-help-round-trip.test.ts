import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolMetricSchema } from "@cogworks/contracts/protocol";

/**
 * A metric's explanation has to survive the hosted path, not just the local one.
 *
 * Week 3's `search_mrr` describes the whole application end to end and its help
 * runs to 645 characters. The hosted protocol capped help at 600, so a Language
 * run that bound its search side answered 400 on the completed event and lost a
 * result it had already computed. Nothing local caught it: `MetricSchema.help`
 * in schema.ts has no limit, so the same string round-trips through a saved
 * report untouched, and `search_mrr` is only emitted once the search side
 * binds, so a text-only result never sent the metric that would have been
 * refused.
 *
 * The wire cap is not an attempt to match storage, which is unbounded. It is a
 * request bound, and what these assert is that it clears the longest help the
 * bundled benchmarks actually send by enough that prose can grow a sentence.
 */

function metric(help: string) {
  return {
    key: "search_mrr",
    label: "Search MRR",
    value: 0.2266783120627169,
    unit: null,
    higherIsBetter: true,
    primary: false,
    precision: 3,
    help,
  };
}

test("the wire accepts the longest help a bundled benchmark sends", () => {
  // Week 3's search_mrr, the exact length that was refused.
  assert.equal(ProtocolMetricSchema.safeParse(metric("x".repeat(645))).success, true);
});

test("the wire leaves room for that prose to grow", () => {
  assert.equal(ProtocolMetricSchema.safeParse(metric("x".repeat(1_000))).success, true);
});

test("help is still bounded, so one metric cannot carry an unbounded request", () => {
  assert.equal(ProtocolMetricSchema.safeParse(metric("x".repeat(1_001))).success, false);
});
