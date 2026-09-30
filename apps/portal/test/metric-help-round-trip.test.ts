import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolMetricSchema, RunEventV1Schema } from "@cogworks/contracts/protocol";
import { MetricSchema } from "@cogworks/contracts/schema";

// From run_28df471772: this valid 645-character explanation caused the
// completed event to return 400 under the former 600-character cap.
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

test("Week 3's 645-character help survives the completed-event and stored schemas", () => {
  assert.equal(WEEK3_SEARCH_MRR_HELP.length, 645);
  const event = RunEventV1Schema.parse({
    protocolVersion: "1",
    eventId: "event_01",
    runId: "run_01",
    sequence: 6,
    occurredAt: 1784000000000,
    type: "completed",
    result: {
      protocolVersion: "1",
      benchmarkId: "language-search",
      benchmarkVersion: 1,
      metrics: [metric(WEEK3_SEARCH_MRR_HELP)],
      diagnostics: [],
      outputDigest: "a".repeat(64),
    },
    preparedArtifactId: "snapshot-01",
    environmentDigest: "b".repeat(64),
    sanitizedLog: null,
  });
  assert.ok(event.type === "completed");
  const stored = MetricSchema.parse(event.result.metrics[0]);
  assert.equal(stored.help, WEEK3_SEARCH_MRR_HELP);
});

test("long help is retained without a replacement character cap", () => {
  const help = "x".repeat(5_000);
  const wire = ProtocolMetricSchema.parse(metric(help));
  assert.equal(wire.help, help);
  assert.equal(MetricSchema.parse(wire).help, help);
});

test("uncapped help still requires string metadata", () => {
  for (const help of [42, {}, ["explanation"]]) {
    const declared = { ...metric(WEEK3_SEARCH_MRR_HELP), help };
    for (const schema of [ProtocolMetricSchema, MetricSchema]) {
      const result = schema.safeParse(declared);
      assert.ok(!result.success);
      assert.deepEqual(result.error.issues.map((issue) => issue.path), [["help"]]);
    }
  }
});

test("long help does not bypass the existing metric contract", () => {
  const result = ProtocolMetricSchema.safeParse({
    ...metric(WEEK3_SEARCH_MRR_HELP),
    precision: 7,
  });
  assert.ok(!result.success);
  assert.deepEqual(result.error.issues.map((issue) => issue.path), [["precision"]]);
});
