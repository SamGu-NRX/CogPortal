import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { Window } from "happy-dom";
import { RunSurfaceSnapshotSchema, type RunDetail } from "@cogworks/contracts/schema";
import { RunConsole } from "../src/components/RunConsole.tsx";
import { RunDetailPage } from "../src/routes/RunDetailPage.tsx";

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run_failed_123", mode: "practice", status: "failed",
    benchmarkId: "audio-identification", benchmarkVersion: 1,
    contractVersion: "1", parentRunId: null,
    repo: { owner: "recorded", name: "source", fullName: "recorded/source", url: "https://github.com/recorded/source" },
    sourceRefusal: null, branch: "detached", sha: "b".repeat(40), shortSha: "bbbbbbb",
    createdAt: 1_750_000_000_000, finishedAt: 1_750_000_008_000,
    attemptNumber: null, primaryMetric: null,
    failure: { category: "student_runtime", phase: "evaluating", consumedAttempt: true, detail: "RuntimeError: fixture exception" },
    phases: [], metrics: [], diagnostics: [], sweep: null, wiring: [], refusal: null,
    weightsSupplied: [], log: "practice traceback", selected: false, publishable: false,
    ...overrides,
  };
}

async function mount(t: TestContext, element: React.ReactNode) {
  const window = new Window({ url: "https://portal.example" });
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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

function page(t: TestContext, record: RunDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  client.setQueryData(["run", record.id], record);
  client.setQueryData(["session"], { auth: { executionProvider: "fixture" } });
  client.setQueryData(["benchmarks"], []);
  client.setQueryData(["dashboard", record.benchmarkId], {
    quota: { officialUsed: 1, officialLimit: 3, practiceUsed: 2, practiceLimit: 10 },
  });
  t.after(() => client.clear());
  return React.createElement(QueryClientProvider, { client },
    React.createElement(MemoryRouter, { initialEntries: [`/runs/${record.id}`] },
      React.createElement(Routes, null,
        React.createElement(Route, { path: "/runs/:runId", element: React.createElement(RunDetailPage) }))));
}

for (const mode of ["practice", "official"] as const) {
  test(`${mode} failure keeps diagnostics behind reversible details without a replacement-run action`, async (t) => {
    const { window, container } = await mount(t, page(t, run({ mode })));
    assert.match(container.textContent, /Run failed/);
    assert.match(container.textContent, /Your code raised an exception/);
    assert.match(container.textContent, /recorded\/source/);
    assert.match(container.textContent, /detached/);
    assert.doesNotMatch(container.textContent, /consumed|refund|Run practice again|Retry/);
    const detail = [...container.querySelectorAll("pre")].find((node) => node.textContent.includes("fixture exception"));
    assert.ok(detail?.closest('[aria-hidden="true"][inert]'));
    assert.equal(container.textContent.includes("practice traceback"), mode === "practice");
    const toggle = [...container.querySelectorAll("button")].find((node) => node.textContent === "Show details");
    assert.ok(toggle);
    toggle.focus();
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(detail.closest('[aria-hidden="true"]'), null);
    assert.equal(window.document.activeElement, toggle);
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.ok(detail.closest('[aria-hidden="true"][inert]'));
    assert.equal(window.document.activeElement, toggle);
  });
}

test("failed late findings stay hidden history, with no publication or promotion", async (t) => {
  const metric = { key: "accuracy", label: "Late accuracy", value: 0.1, unit: null, primary: true, precision: 3, higherIsBetter: true, role: null, relatesTo: null, help: null };
  const { container } = await mount(t, page(t, run({
    mode: "official", metrics: [metric], primaryMetric: metric,
    diagnostics: ["Late diagnostic from the failed execution"],
  })));
  const finding = [...container.querySelectorAll("p")].find((node) => node.textContent === "Late diagnostic from the failed execution");
  assert.ok(finding?.closest('[aria-hidden="true"][inert]'));
  assert.match(container.textContent, /Late accuracy/);
  assert.doesNotMatch(container.textContent, /Publish to leaderboard|Promote to official|RESULTS|practice traceback/);
});

test("missing failure metadata still reports failure without inventing a cause", async (t) => {
  const { container } = await mount(t, page(t, run({ failure: null, log: null })));
  assert.match(container.textContent, /Run failed/);
  assert.doesNotMatch(container.textContent, /No failure reason was recorded/);
  assert.doesNotMatch(container.textContent, /raised an exception/);
});

test("provider failure keeps staff escalation in details", async (t) => {
  const { container } = await mount(t, page(t, run({
    failure: { category: "provider", phase: "evaluating", consumedAttempt: false, detail: null },
  })));
  assert.match(container.textContent, /The run couldn't finish/);
  assert.doesNotMatch(container.textContent, /Execution provider failed/);
  const escalation = [...container.querySelectorAll("p")].find((node) => node.textContent.includes("course staff"));
  assert.ok(escalation?.closest('[aria-hidden="true"][inert]'));
});

for (const publishable of [false, true]) {
  test(`official publication follows server publishable=${publishable}`, async (t) => {
    const { container } = await mount(t, page(t, run({
      mode: "official", status: "succeeded", failure: null, publishable,
      selected: !publishable,
    })));
    assert.equal(container.textContent.includes("Publish to leaderboard"), publishable);
    assert.doesNotMatch(container.textContent, /ATTEMPT REFUNDED|returned your attempt|This result is your team's public entry/);
  });
}

test("completed partial evaluation retains findings, supporting results and promotion", async (t) => {
  const { container } = await mount(t, page(t, run({
    status: "succeeded", failure: null,
    metrics: [{ key: "text_mrr", label: "Text MRR", value: 0.05, precision: 3, primary: false, unit: null, higherIsBetter: true, role: null, relatesTo: null, help: null }],
    diagnostics: ["Only the text capability was measured."],
  })));
  assert.match(container.textContent, /Only the text capability was measured/);
  assert.match(container.textContent, /This run has no overall score/);
  assert.match(container.textContent, /Text MRR/);
  assert.match(container.textContent, /Promote to official/);
  assert.doesNotMatch(container.textContent, /Run failed|Saved results/);
});

test("console failure ignores late completion in its summary, retaining it only in details", async (t) => {
  const snapshot = RunSurfaceSnapshotSchema.parse({
    id: `surface_${"a".repeat(20)}`, team: { id: "team-1", name: "Team" },
    benchmark: { id: "audio-identification", version: 1, title: "Audio" }, actor: { login: "ada", name: null },
    sha: "b".repeat(40), shortSha: "bbbbbbb", branch: "detached", dirty: false,
    stage: "hosted", status: "failed", phase: "failed", createdAt: 1000, updatedAt: 9000, finishedAt: 8000, elapsedMs: 7000,
    progress: null, primaryMetric: { key: "accuracy", label: "Late accuracy", value: 0.1, precision: 3, primary: true, unit: null, higherIsBetter: true },
    localRunId: null, practiceRunId: "physical_failed", officialRunId: null,
    published: false, nextOfficialAttempt: 1, source: null, sourceRefusal: null,
    actions: ["run_again", "rerun_hosted"], simulated: true,
    events: ["run.failed.provider", "run.completed"].map((code, index) => ({
      eventId: `stream_event_${index}`, source: "practice", sourceRunId: "physical_failed", sourceSequence: index,
      phase: "scoring", code, occurredAt: 8000 + index, elapsedMs: 7000 + index, progress: null,
    })),
  });
  const element = (value: typeof snapshot) => React.createElement(RunConsole, { snapshot: value, streamState: "closed" });
  const { container, root, window } = await mount(t, element({ ...snapshot, status: "running" }));
  const liveLog = container.querySelector("ul");
  assert.ok(liveLog);
  liveLog.focus();
  assert.equal(window.document.activeElement, liveLog);
  await act(async () => root.render(element(snapshot)));
  assert.match(container.textContent, /Run failed/);
  assert.match(container.textContent, /The hosted runner could not finish/);
  assert.doesNotMatch(container.textContent, /Late accuracy|Run complete|Run again|Rerun hosted|runner's terminal/);
  const toggle = [...container.querySelectorAll("button")].find((node) => node.textContent === "Show details");
  assert.ok(toggle);
  assert.equal(window.document.activeElement, toggle);
  await act(async () => toggle.click());
  assert.match(container.textContent, /Saved results/);
  assert.match(container.textContent, /Late accuracy: 0.100/);
  assert.match(container.textContent, /Run complete/);
  assert.equal(window.document.activeElement, toggle);
  await act(async () => toggle.click());
  assert.doesNotMatch(container.textContent, /Late accuracy|Run complete/);
  assert.equal(window.document.activeElement, toggle);
  await act(async () => toggle.click());
  const historyLog = container.querySelector("ul");
  assert.ok(historyLog);
  historyLog.focus();
  await act(async () => root.render(element({ ...snapshot, practiceRunId: "physical_new", events: [], primaryMetric: null })));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(window.document.activeElement, toggle);
  assert.doesNotMatch(container.textContent, /physical_failed|Late accuracy|Run complete/);

  const elsewhere = window.document.createElement("button");
  window.document.body.append(elsewhere);
  await act(async () => root.render(element({ ...snapshot, status: "running" })));
  elsewhere.focus();
  await act(async () => root.render(element(snapshot)));
  assert.equal(window.document.activeElement, elsewhere);
});
