import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolMetricSchema } from "@cogworks/contracts/protocol";
import { MetricSchema } from "@cogworks/contracts/schema";

/**
 * A metric's explanation has to survive the hosted path, not just the local one.
 *
 * Week 3's `search_mrr` describes the whole application end to end and its help
 * runs to 645 characters. The stored side never had a limit, so that string
 * round-tripped through a local report fine; the hosted protocol capped help at
 * 600, so a Language run that bound its search side answered 400 on the
 * completed event and lost a result it had already computed. The discovery
 * defect that kept the search side unbound had been hiding it, because a
 * text-only result never sends that metric.
 *
 * The rule these assert is that the receiving cap is not tighter than what the
 * benchmarks already say and what the database already keeps.
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

test("the hosted protocol accepts the longest help a bundled benchmark sends", () => {
  // The observed length of Week 3's search_mrr help, which used to be refused.
  assert.equal(ProtocolMetricSchema.safeParse(metric("x".repeat(645))).success, true);
});

test("a metric's help is not capped tighter on the wire than in storage", () => {
  // Storage keeps help whole, so anything it would keep has to be deliverable.
  const long = "x".repeat(1_000);
  assert.equal(MetricSchema.safeParse(metric(long)).success, true);
  assert.equal(ProtocolMetricSchema.safeParse(metric(long)).success, true);
});

test("help is still bounded, so one metric cannot carry an unbounded request", () => {
  assert.equal(ProtocolMetricSchema.safeParse(metric("x".repeat(1_001))).success, false);
});
