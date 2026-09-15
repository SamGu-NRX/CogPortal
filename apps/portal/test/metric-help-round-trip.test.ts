import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolMetricSchema } from "@cogworks/contracts/protocol";
import { MetricSchema } from "@cogworks/contracts/schema";

/**
 * A metric's explanation has to survive the hosted path, not just the local one.
 *
 * This is Week 3's real `search_mrr` help, copied from the result of
 * run_28df471772. The hosted protocol used to cap help at 600 characters and
 * this is 645, so that run answered 400 on its completed event and lost a score
 * it had already measured. Nothing local caught it: the stored side has no
 * limit, so the identical string round-trips through a saved report untouched,
 * and `search_mrr` is only emitted once a submission's search side binds.
 */
const WEEK3_SEARCH_MRR_HELP =
  "The application end to end: a query string in, ranked image ids out, " +
  "through whatever database the submission built. This is the average over " +
  "four versions of every query (the caption unchanged, its keywords only, " +
  "its first three words, and one with a typo), so it asks whether search " +
  "holds up on what a person would actually type rather than only on a " +
  "caption handed back verbatim. The four are listed separately further down, " +
  "so a low score here can be traced to the rewrite that caused it. Weak here " +
  "while the two above are strong points at the plumbing, meaning the " +
  "database, the id mapping, or the query path, rather than at the embeddings.";

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

test("Week 3's own search_mrr explanation reaches the portal whole", () => {
  const parsed = ProtocolMetricSchema.safeParse(metric(WEEK3_SEARCH_MRR_HELP));
  assert.equal(parsed.success, true);
  // Whole, not truncated: the text a student reads is the text the benchmark
  // wrote.
  assert.equal(parsed.success && parsed.data.help, WEEK3_SEARCH_MRR_HELP);
});

test("the wire and the stored report keep the same explanation", () => {
  const wire = ProtocolMetricSchema.safeParse(metric(WEEK3_SEARCH_MRR_HELP));
  const stored = MetricSchema.safeParse({ ...metric(WEEK3_SEARCH_MRR_HELP), role: "scored" });
  assert.equal(wire.success, true);
  assert.equal(stored.success, true);
  assert.equal(
    wire.success && stored.success && wire.data.help === stored.data.help,
    true,
  );
});

test("the schema no longer decides how long an explanation may be", () => {
  assert.equal(ProtocolMetricSchema.safeParse(metric("x".repeat(5_000))).success, true);
});
