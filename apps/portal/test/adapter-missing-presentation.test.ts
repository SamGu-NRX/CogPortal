import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_DISCOVERY_MESSAGES,
  adapterDiscoveryOutcome,
  resolveFailureCopy,
} from "@cogworks/contracts/failures";
import type { RunDetail } from "@cogworks/contracts/schema";
import { RunDetailPage } from "../src/routes/RunDetailPage.tsx";

// An unrecognized detail line: packaging machinery the fallback folds away.
const RAW = 'Entry-point group "cogworks.submissions.v2" has no registration for this benchmark.';
// The runner's three discovery outcomes, as its prepare script raises them
// and `_last_error_line` reports them (see modal_app.py).
const MISSING =
  "RuntimeError: No adapter found in face-finder, and no set of functions in it performed the benchmark's task. No function returned a descriptor for a face.";
const AMBIGUOUS = "RuntimeError: Submission adapter entry point is ambiguous.";
const UNFINISHED = "RuntimeError: The search for your code could not finish: ModuleNotFoundError: No module named 'facenet_models'";

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

function failedWith(detail: string): RunDetail {
  return run({ failure: { category: "adapter_missing", phase: "contract_check", consumedAttempt: false, detail } });
}

/** Visible text: everything outside a collapsed disclosure. */
function visibleText(container: Element): string {
  return [...container.querySelectorAll("h1, h2, h3, p, span, pre")]
    .filter((node) => !node.closest('[aria-hidden="true"]'))
    .map((node) => node.textContent ?? "")
    .join("\n");
}

test("an unrecognized adapter_missing detail gets the neutral fallback and folds the raw line", async (t) => {
  const { container } = await mount(t, page(t, run()));
  const text = visibleText(container);
  assert.match(text, /Nothing here could be scored/);
  // The explanation lives in the card's details, beside the raw line.
  assert.match(container.textContent ?? "", /did not reach scoring/);
  assert.match(text, /Run the check below/);
  // The fallback diagnoses nothing: it cannot know the project is wrong.
  assert.doesNotMatch(container.textContent ?? "", /doesn't match|didn't find|did this benchmark's task/);
  assert.doesNotMatch(text, /entry-point|cogworks\.submissions/i);
  // The raw runner detail is preserved, and it waits behind the disclosure.
  const raw = [...container.querySelectorAll("pre")].find((n) => n.textContent === RAW);
  assert.ok(raw, "the raw runner detail must stay available on the card");
  assert.notEqual(raw!.closest('[aria-hidden="true"]'), null);
  assert.ok([...container.querySelectorAll("button")].some((n) => n.textContent === "Show details"));
});

test("a finished search that found nothing says so, with the search's own line open", async (t) => {
  const { container } = await mount(t, page(t, failedWith(MISSING)));
  const text = visibleText(container);
  assert.match(text, /No function in your project did this benchmark's task/);
  assert.match(container.textContent ?? "", /searched all of it/);
  const raw = [...container.querySelectorAll("pre, p")].find((n) => n.textContent?.includes("No adapter found in face-finder"));
  assert.ok(raw, "the runner's line is on the card");
  assert.equal(raw!.closest('[aria-hidden="true"]'), null, "and open, because it carries the search's verdict");
});

test("an ambiguous registration says which choice the student has to make", async (t) => {
  const { container } = await mount(t, page(t, failedWith(AMBIGUOUS)));
  const text = visibleText(container);
  assert.match(text, /registers more than one adapter/);
  assert.match(text, /Keep one registration/);
  assert.doesNotMatch(text, /No function in your project|didn't finish/);
});

test("an unfinished search never claims the code is missing", async (t) => {
  const { container } = await mount(t, page(t, failedWith(UNFINISHED)));
  const text = visibleText(container);
  assert.match(text, /The search for your code didn't finish/);
  assert.match(container.textContent ?? "", /can't say yet whether they're there/);
  assert.doesNotMatch(container.textContent ?? "", /No function in your project|registers more than one|doesn't match/);
  // The reason it stopped is the evidence, so it is shown.
  assert.match(text, /No module named 'facenet_models'/);
});

test("discovery outcomes are read from the runner's exact sentences and nothing else", () => {
  assert.equal(adapterDiscoveryOutcome(MISSING), "missing");
  assert.equal(adapterDiscoveryOutcome(AMBIGUOUS), "ambiguous");
  assert.equal(adapterDiscoveryOutcome(UNFINISHED), "unfinished");
  // Without the exception prefix, as a log line or a test fixture carries it.
  assert.equal(adapterDiscoveryOutcome("The search for your code could not finish."), "unfinished");
  for (const other of [RAW, "", null, undefined, "Something mentions no adapter found later on", "entry point"]) {
    assert.equal(adapterDiscoveryOutcome(other), null, String(other));
  }
  // Only adapter_missing reads the detail.
  assert.equal(
    resolveFailureCopy("student_runtime", { benchmarkId: "x", detail: UNFINISHED }).title,
    resolveFailureCopy("student_runtime", { benchmarkId: "x" }).title,
  );
});

test("every discovery sentence the portal reads is one the runner still raises", () => {
  const runner = readFileSync(
    fileURLToPath(new URL("../../runner-modal/src/cogworks_runner/modal_app.py", import.meta.url)),
    "utf8",
  );
  for (const [outcome, sentence] of Object.entries(ADAPTER_DISCOVERY_MESSAGES)) {
    assert.ok(runner.includes(sentence), `the runner no longer raises the ${outcome} sentence ${JSON.stringify(sentence)}`);
  }
});

test("no adapter_missing copy carries implementation detail", () => {
  for (const detail of [RAW, MISSING, AMBIGUOUS, UNFINISHED]) {
    const copy = resolveFailureCopy("adapter_missing", { benchmarkId: "audio-identification", detail });
    for (const line of [copy.title, copy.explanation, copy.action]) {
      assert.doesNotMatch(line, /entry-point|entry point|cogworks\.|pyproject/i, line);
    }
    assert.match(copy.action, /Run the check below|Keep one registration/);
    assert.equal(copy.code, "E-ADAPTER");
    assert.equal(copy.remedy, "fix");
  }
  // The fallback is what every category-only surface (the admin roster) shows.
  assert.equal(resolveFailureCopy("adapter_missing", { benchmarkId: "x" }).title, "Nothing here could be scored");
});
