import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { Window } from "happy-dom";
import type { RunDetail } from "@cogworks/contracts/schema";
import { SweepTrace } from "../src/components/SweepTrace.tsx";
import { RunDetailPage } from "../src/routes/RunDetailPage.tsx";

type Metric = RunDetail["metrics"][number];

function metric(over: Partial<Metric> & Pick<Metric, "key" | "label" | "value">): Metric {
  return {
    unit: null, primary: false, precision: 3, higherIsBetter: true,
    role: null, relatesTo: null, help: null, ...over,
  };
}

const PRIMARY = metric({ key: "overall", label: "Overall", value: 0.61, primary: true });
const TEXT_MRR = metric({
  key: "text_mrr", label: "Text MRR", value: 0.58,
  help: "How high the right caption ranks, averaged over every query.",
});

function succeeded(over: Partial<RunDetail>): RunDetail {
  return {
    id: "run_current_1", mode: "practice", status: "succeeded",
    benchmarkId: "language-search", benchmarkVersion: 1,
    contractVersion: "1", parentRunId: null, surfaceId: null,
    repo: { owner: "demo", name: "search", fullName: "demo/search", url: "https://github.com/demo/search" },
    sourceRefusal: null, branch: "main", sha: "c".repeat(40), shortSha: "ccccccc",
    createdAt: 1_750_000_100_000, finishedAt: 1_750_000_130_000,
    attemptNumber: null, primaryMetric: PRIMARY, failure: null,
    phases: [], metrics: [PRIMARY, TEXT_MRR], diagnostics: ["Text search holds up; images trail it."],
    sweep: null, wiring: [], refusal: null, weightsSupplied: [], log: null,
    selected: false, publishable: false,
    ...over,
  };
}

test("a comparison that arrives late keeps an open reading open and focused", async (t) => {
  // The dashboard names the previous run, and it can answer after the student
  // has already opened a row. That arrival used to remount the readings.
  const window = new Window({ url: "https://portal.example" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
    // Every request stays in flight; the test hands responses to the cache
    // itself, at the moment it chooses.
    fetch: () => new Promise<Response>(() => {}),
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const current = succeeded({});
  const before = succeeded({
    id: "run_previous_1", createdAt: 1_750_000_000_000, finishedAt: 1_750_000_020_000,
    metrics: [{ ...PRIMARY, value: 0.55 }, { ...TEXT_MRR, value: 0.5 }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  client.setQueryData(["run", current.id], current);
  client.setQueryData(["session"], { auth: { executionProvider: "fixture" } });
  client.setQueryData(["benchmarks"], []);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses, with separate TS interfaces.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [`/runs/${current.id}`] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/runs/:runId", element: React.createElement(RunDetailPage) })))),
  ));

  // The query cache tells its subscribers on a timer, not synchronously.
  const deliver = (write: () => void) => act(async () => {
    write();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const row = [...container.querySelectorAll("button")].find((node) => node.textContent.includes("Text MRR"));
  assert.ok(row);
  assert.doesNotMatch(container.textContent, /Changes are against/);
  row.focus();
  await act(async () => row.click());
  assert.equal(row.getAttribute("aria-expanded"), "true");

  await deliver(() => {
    client.setQueryData(["dashboard", current.benchmarkId], {
      quota: { officialUsed: 0, officialLimit: 3, practiceUsed: 2, practiceLimit: 10 },
      runs: [
        { id: current.id, status: "succeeded", mode: "practice", benchmarkId: current.benchmarkId,
          benchmarkVersion: 1, createdAt: current.createdAt, branch: "main", primaryMetric: PRIMARY },
        { id: before.id, status: "succeeded", mode: "practice", benchmarkId: before.benchmarkId,
          benchmarkVersion: 1, createdAt: before.createdAt, branch: "main", primaryMetric: before.metrics[0] },
      ],
    });
  });
  assert.match(container.textContent, /Changes are against/);
  const stillOpen = () => {
    assert.equal(row.isConnected, true, "the row was replaced by a new one");
    assert.equal(row.getAttribute("aria-expanded"), "true");
    assert.equal(window.document.activeElement, row);
  };
  stillOpen();

  await deliver(() => client.setQueryData(["run", before.id], before));
  // The previous run's record has reached the rows: Text MRR now carries its change.
  assert.match(row.textContent, /\+0\.08/);
  stillOpen();
});

test("a screen reader hears the previous run's curve, not only this run's", () => {
  const axis = "query rewrite";
  const sweep = {
    axis, metric: "text_mrr",
    points: [
      { x: 0, y: 0.81, label: "verbatim" },
      { x: 1, y: 0.7, label: "synonyms" },
      { x: 2, y: 0.44, label: "paraphrase" },
    ],
  };
  const previous = {
    axis, metric: "text_mrr",
    points: [
      { x: 0, y: 0.73, label: "verbatim" },
      { x: 1, y: 0.61, label: "synonyms" },
      { x: 2, y: 0.29, label: "paraphrase" },
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(SweepTrace, { sweep, previous, previousLabel: "Run #D8DF" }),
  );
  const label = /role="img" aria-label="([^"]*)"/.exec(html)?.[1];
  assert.ok(label);
  assert.match(label, /This run: 0\.81 at verbatim, 0\.70 at synonyms, 0\.44 at paraphrase\./);
  assert.match(label, /Run #D8DF, before this one: 0\.73 at verbatim, 0\.61 at synonyms, 0\.29 at paraphrase\./);

  // Without a comparison the label reads as one series, unnamed.
  const alone = /role="img" aria-label="([^"]*)"/.exec(
    renderToStaticMarkup(React.createElement(SweepTrace, { sweep })),
  )?.[1];
  assert.equal(
    alone,
    "text mrr against query rewrite: 0.81 at verbatim, 0.70 at synonyms, 0.44 at paraphrase. The largest fall comes after synonyms.",
  );
});
