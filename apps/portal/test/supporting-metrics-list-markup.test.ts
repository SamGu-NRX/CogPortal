import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import type { Metric } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { SupportingMetrics } from "../src/components/MetricBlock.tsx";

/**
 * The run page's supporting metrics are a <dl>. The real-journeys M4 pass
 * (axe on /runs/:id) found it invalid: every row was wrapped in a second
 * <div>, and a row with a note put its <dt> and <dd> inside a <button>. A
 * screen reader then can't pair a label with its value. HTML allows a <dl>
 * to hold <div> groups of <dt>/<dd> one level deep, nothing else.
 */

function metric(over: Partial<Metric> & Pick<Metric, "key" | "label" | "value">): Metric {
  return { unit: null, higherIsBetter: true, primary: false, precision: 3, help: null, role: null, relatesTo: null, ...over };
}

const METRICS: Metric[] = [
  metric({ key: "known", label: "Known identification", value: 0.826, role: "scored" }),
  metric({ key: "unknown", label: "Unknown lifecycle", value: 0.762, role: "scored", help: "How often an unknown face is left unnamed." }),
  metric({ key: "probe", label: "Verbatim lookup", value: 0.9, role: "reported", relatesTo: "known" }),
  metric({ key: "latency", label: "Mean latency", value: 310, unit: "ms", role: "diagnostic", help: "Wall time per case." }),
];

function render(): Document {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(React.createElement(SupportingMetrics, { metrics: METRICS }));
  return window.document as unknown as Document;
}

test("every term and description sits in a <div> group directly inside its <dl>", () => {
  const document = render();
  const items = [...document.querySelectorAll("dt, dd")];
  assert.ok(items.length >= 8, `rendered ${items.length} dt/dd`);
  for (const item of items) {
    const group = item.parentElement!;
    assert.equal(group.tagName, "DIV", `${item.tagName} "${item.textContent}" is inside <${group.tagName.toLowerCase()}>`);
    assert.equal(group.parentElement!.tagName, "DL", `the group around "${item.textContent}" is inside <${group.parentElement!.tagName.toLowerCase()}>`);
    for (const child of group.children) assert.match(child.tagName, /^(DT|DD)$/, `a group holds <${child.tagName.toLowerCase()}>`);
  }
});

test("a row with a note keeps its label as the toggle and the note as the row's own description", () => {
  const document = render();
  const buttons = [...document.querySelectorAll("dl button")];
  assert.deepEqual(buttons.map((b) => b.textContent), ["Unknown lifecycle", "Mean latency"]);
  for (const button of buttons) {
    assert.equal(button.parentElement!.tagName, "DT");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    const note = document.getElementById(button.getAttribute("aria-controls")!)!;
    assert.equal(note.tagName, "DD");
    assert.equal(note.parentElement, button.parentElement!.parentElement, "the note is in the same group as its label");
    assert.ok(note.hasAttribute("hidden"), "closed notes stay out of the accessibility tree");
  }
});
