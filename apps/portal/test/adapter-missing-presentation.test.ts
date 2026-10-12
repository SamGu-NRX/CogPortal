import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { Window } from "happy-dom";
import { resolveFailureCopy } from "@cogworks/contracts/failures";
import type { RunDetail } from "@cogworks/contracts/schema";
import { RunDetailPage } from "../src/routes/RunDetailPage.tsx";

const RAW = 'Entry-point group "cogworks.submissions.v2" has no registration for this benchmark.';

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run_failed_adapter", mode: "practice", status: "failed",
    benchmarkId: "audio-identification", benchmarkVersion: 1,
    contractVersion: "1", parentRunId: null, surfaceId: null,
    repo: { owner: "recorded", name: "source", fullName: "recorded/source", url: "https://github.com/recorded/source" },
    sourceRefusal: null, branch: "missing-adapter", sha: "b".repeat(40), shortSha: "bbbbbbb",
    createdAt: 1_750_000_000_000, finishedAt: 1_750_000_008_000,
    attemptNumber: null, primaryMetric: null,
    failure: { category: "adapter_missing", phase: "contract_check", consumedAttempt: false, detail: RAW },
    phases: [], metrics: [], diagnostics: [], sweep: null, wiring: [], refusal: null,
    weightsSupplied: [], log: "", selected: false, publishable: false, publicationRefusal: null,
    ...overrides,
  };
}

async function mount(t: TestContext, element: React.ReactNode) {
  const window = new Window({ url: "https://portal.example" });
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)!]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses, with separate TS interfaces.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(element));
  return { window, container, root };
}

function page(t: TestContext, record: RunDetail, officialUsed = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  client.setQueryData(["run", record.id], record);
  client.setQueryData(["session"], { auth: { executionProvider: "fixture" } });
  client.setQueryData(["benchmarks"], []);
  client.setQueryData(["dashboard", record.benchmarkId], {
    quota: { officialUsed, officialLimit: 3, practiceUsed: 2, practiceLimit: 10 },
  });
  t.after(() => client.clear());
  return React.createElement(QueryClientProvider, { client },
    React.createElement(MemoryRouter, { initialEntries: [`/runs/${record.id}`] },
      React.createElement(Routes, null,
        React.createElement(Route, { path: "/runs/:runId", element: React.createElement(RunDetailPage) }))));
}

test("the adapter-missing card leads with course terms and folds the runner's raw line", async (t) => {
  const { container } = await mount(t, page(t, run()));
  const text = container.textContent;
  // What happened, in course terms, then the one next action.
  assert.match(text, /couldn't find a submission to run/);
  assert.match(text, /Run the check below/);
  // The headline carries no implementation detail: nothing visible may name
  // the entry-point group machinery.
  for (const node of container.querySelectorAll("h1, h2, p, span")) {
    if (node.closest('[aria-hidden="true"]')) continue;
    assert.doesNotMatch(node.textContent ?? "", /entry-point|cogworks\.submissions/i, node.textContent ?? "");
  }
  // The raw runner detail is preserved, and it waits behind the disclosure.
  const raw = [...container.querySelectorAll("pre")].find((n) => n.textContent === RAW);
  assert.ok(raw, "the raw runner detail must stay available on the card");
  assert.notEqual(raw!.closest('[aria-hidden="true"]'), null);
  assert.ok([...container.querySelectorAll("button")].some((n) => n.textContent === "Show details"));
});

test("adapter_missing copy itself carries no implementation detail", () => {
  const copy = resolveFailureCopy("adapter_missing", { benchmarkId: "audio-identification" });
  for (const line of [copy.title, copy.explanation, copy.action]) {
    assert.doesNotMatch(line, /entry-point|cogworks\.|pyproject/i, line);
  }
  assert.equal(copy.detailOpen, false);
  assert.match(copy.action, /Run the check below/);
});
