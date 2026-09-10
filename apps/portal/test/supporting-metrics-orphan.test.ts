import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metric } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { PrimaryMetric, SupportingMetrics } from "../src/components/MetricBlock.tsx";

/**
 * A floor is drawn inside the row of the metric it is the scale of, which
 * means it is removed from the list of standalone rows. That removal assumed
 * the parent was in the list, and both real benchmarks break the assumption.
 *
 * Week 3 withholds `retrieval_mrr` when the image side is unmeasured and still
 * publishes `chance_mrr`. The run page also lifts the primary metric out of
 * this list before rendering it, so a floor attached to the primary has no
 * parent here either. In both cases the number was filtered out of the table
 * and never drawn anywhere, so a student lost it entirely.
 */

function metric(over: Partial<Metric> & Pick<Metric, "key" | "label" | "value">): Metric {
  return {
    unit: null,
    higherIsBetter: true,
    primary: false,
    precision: 3,
    help: null,
    role: null,
    relatesTo: null,
    ...over,
  };
}

const FLOOR = metric({
  key: "chance_mrr",
  label: "Chance MRR",
  value: 0.0102,
  role: "floor",
  relatesTo: "retrieval_mrr",
});

const PARENT = metric({ key: "retrieval_mrr", label: "Retrieval MRR", value: 0.2586, role: "scored" });

function render(metrics: Metric[]): string {
  return renderToStaticMarkup(React.createElement(SupportingMetrics, { metrics }));
}

test("a floor beside its parent is drawn as that parent's scale, not a row", () => {
  const html = render([PARENT, FLOOR]);
  assert.ok(html.includes("Retrieval MRR"), "the parent should render");
  assert.ok(html.includes("floor 0.010"), "the floor should render as the parent's scale");
  assert.ok(!html.includes("Chance MRR"), "the floor should not also have its own row");
});

test("a floor whose parent is withheld keeps a row instead of disappearing", () => {
  const html = render([FLOOR]);
  assert.ok(html.includes("Chance MRR"), "the floor was filtered out with nowhere to go");
  assert.ok(html.includes("0.010"), "its value should still be readable");
  // Standalone or not, a floor never carries a direction: it is a fact about
  // the dataset, so "higher is better" would be advice about a number the
  // submission does not control.
  assert.ok(!html.includes("higher is better"), "a floor claimed a direction");
  assert.ok(!html.includes("▲"), "a floor drew an arrow");
});

test("a probe whose parent is the primary metric keeps a row", () => {
  // RunDetailPage renders the primary above this component and passes only the
  // rest, so `relatesTo` pointing at it finds nothing here.
  const probe = metric({
    key: "retrieval_mrr_verbatim",
    label: "Retrieval MRR, caption unchanged",
    value: 0.2586,
    role: "reported",
    relatesTo: "overall",
  });
  const html = render([probe]);
  assert.ok(html.includes("Retrieval MRR, caption unchanged"), "the probe vanished");
  assert.ok(html.includes("not scored"), "a reported probe should say it is not scored");
});

test("a floor of a floor keeps its own row instead of vanishing", () => {
  // `floor_b → floor_a → score`. floor_a moves into score's row, so it is not
  // a row floor_b can move into. Absorbing floor_b anyway deleted its number
  // from the page with nothing left pointing at it.
  const floorA = metric({
    key: "floor_a",
    label: "Floor A",
    value: 0.1,
    role: "floor",
    relatesTo: "score",
  });
  const floorB = metric({
    key: "floor_b",
    label: "Floor B",
    value: 0.05,
    role: "floor",
    relatesTo: "floor_a",
  });
  const score = metric({ key: "score", label: "Score", value: 0.5, role: "scored" });

  const html = render([score, floorA, floorB]);
  assert.ok(html.includes("Score"), "the parent should render");
  assert.ok(html.includes("floor 0.100"), "floor A should be score's scale");
  assert.ok(!html.includes("Floor A"), "floor A should not also have a row");
  assert.ok(html.includes("Floor B"), "floor B was deleted with nowhere to go");
});

test("a metric that points at itself is nobody's child", () => {
  // The contract does not forbid it. Absorbing it removed the only row and
  // rendered an empty list.
  const html = render([
    metric({
      key: "chance_mrr",
      label: "Chance MRR",
      value: 0.0102,
      role: "floor",
      relatesTo: "chance_mrr",
    }),
  ]);
  assert.ok(html.includes("Chance MRR"), "the metric disappeared entirely");
});

test("a floor moved beside the primary keeps its explanation", () => {
  // Week 1 declares two floors of its primary metric, so they render here
  // rather than as supporting rows. A supporting row can unfold its note; this
  // block cannot, so without carrying `help` the benchmark's own sentence
  // ("1/N for a catalog of N songs...") is computed, sent, stored, and then
  // dropped by the page. That is the exact failure CLAUDE.md names.
  const primary = metric({
    key: "identification_score",
    label: "Identification score",
    value: 0.5312,
    precision: 4,
    primary: true,
    role: "scored",
    help: "This is the leaderboard number.",
  });
  const chance = metric({
    key: "chance_top1",
    label: "Chance",
    value: 0.0333,
    role: "floor",
    relatesTo: "identification_score",
    help: "1/N for a catalog of N songs: what naming a song at random scores.",
  });
  const trivial = metric({
    key: "trivial_baseline_top1",
    label: "Trivial baseline",
    value: 0.0812,
    role: "floor",
    relatesTo: "identification_score",
    help: "Whole-clip mean log spectrum, nearest neighbour. None of the capstone.",
  });

  const html = renderToStaticMarkup(
    React.createElement(PrimaryMetric, { metric: primary, floors: [chance, trivial] }),
  );

  assert.ok(html.includes("Chance"), "the first floor is missing");
  assert.ok(html.includes("Trivial baseline"), "the second floor is missing");
  // Printed at the primary's precision, because comparing them is the point.
  assert.ok(html.includes("0.0333"), "the floor was not printed at the primary's precision");
  assert.ok(html.includes("what naming a song at random scores"), "the floor lost its explanation");
  assert.ok(html.includes("None of the capstone"), "the second floor lost its explanation");
  // Still no direction claim on a property of the dataset. The primary draws
  // exactly one arrow; neither floor adds another.
  assert.equal((html.match(/▲|▼/g) || []).length, 1, "a floor drew a direction arrow");
});

test("a benchmark that sends no floor help renders exactly as before", () => {
  const primary = metric({ key: "p", label: "P", value: 0.5, precision: 4, primary: true, role: "scored" });
  const bare = metric({ key: "f", label: "F", value: 0.1, role: "floor", relatesTo: "p" });
  const html = renderToStaticMarkup(
    React.createElement(PrimaryMetric, { metric: primary, floors: [bare] }),
  );
  assert.ok(html.includes("F"), "the floor is missing");
  assert.ok(!html.includes("border-l border-rule-soft pl-3"), "an empty note block was drawn");
});
