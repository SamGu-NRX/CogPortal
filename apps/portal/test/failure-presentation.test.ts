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
import { RunSurfacePage } from "../src/routes/RunSurfacePage.tsx";
import { useRunSurfaceStream } from "../src/lib/run-surface-stream.ts";
import type { RunSurfaceMutationInput } from "../src/lib/api.ts";

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run_failed_123", mode: "practice", status: "failed",
    benchmarkId: "audio-identification", benchmarkVersion: 1,
    contractVersion: "1", parentRunId: null, surfaceId: null,
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
    assert.match(container.textContent, /RUN _123/);
    assert.doesNotMatch(container.querySelector("h1")?.textContent ?? "", /RUN _123/);
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
    actions: ["rerun_hosted"], simulated: true,
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

function retrySnapshot(mode: "practice" | "official" = "practice") {
  return RunSurfaceSnapshotSchema.parse({
    id: `surface_${"a".repeat(20)}`, team: { id: "team_1", name: "Team" },
    benchmark: { id: "language-search", version: 1, title: "Semantic Image Search" },
    actor: { login: "ada", name: null }, sha: "b".repeat(40), shortSha: "bbbbbbb",
    branch: "detached", dirty: false, source: null, sourceRefusal: null,
    stage: mode === "official" ? "official" : "hosted", status: "failed", phase: "failed",
    createdAt: 1000, updatedAt: 9000, finishedAt: 8000, elapsedMs: 7000,
    progress: null, primaryMetric: null, localRunId: null,
    practiceRunId: mode === "practice" ? "physical_failed" : "physical_practice",
    officialRunId: mode === "official" ? "physical_failed" : null,
    executionGeneration: 1, snapshotRevision: 1,
    executionHistory: [{ id: "physical_failed", mode, status: "failed", retryOfRunId: null, createdAt: 1000, finishedAt: 8000 }],
    published: false, nextOfficialAttempt: 1, actions: ["retry"], simulated: true,
    events: [{ eventId: "failure_event_123", source: mode, sourceRunId: "physical_failed", sourceSequence: 1,
      phase: "evaluating", code: "run.failed.runtime", occurredAt: 8000, elapsedMs: 7000, progress: null }],
  });
}

/** Shiki arrives through a dynamic import, so drive React until the highlighted
 *  markup lands rather than letting it appear in the middle of an assertion. */
async function settleHighlight(scope: { querySelectorAll: (selector: string) => ArrayLike<unknown> }) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (scope.querySelectorAll("span[style]").length > 0) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  assert.fail("the local command never highlighted");
}

for (const compact of [false, true]) {
  test(`failed local console offers its local command with compact=${compact}`, async (t) => {
    const snapshot = {
      ...retrySnapshot(), stage: "local" as const, localRunId: "localrun_failed",
      practiceRunId: null, officialRunId: null, executionHistory: [], events: [],
      actions: ["open_console", "open_portal", "run_again"] as const,
    };
    const command = "cogworks run --benchmark language-search --live";
    const { container, root, window } = await mount(t, React.createElement(RunConsole, {
      snapshot: { ...snapshot, actions: [...snapshot.actions] }, streamState: "closed", compact,
    }));
    const again = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Run again");
    assert.equal(again.length, 1);
    assert.doesNotMatch(container.textContent, /Retry|Rerun hosted/);
    await act(async () => again[0].click());
    const dialog = container.querySelector("dialog");
    assert.ok(dialog);
    assert.equal(dialog.open, true);
    assert.ok(dialog.contains(window.document.activeElement), "an open dialog holds focus");
    await settleHighlight(dialog);
    assert.match(dialog.textContent ?? "", /cogworks run --benchmark language-search --live/);
    assert.ok(dialog.querySelector(".code-block.is-wrapped"), "the command wraps instead of scrolling");

    const copy = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Copy command");
    assert.ok(copy);
    assert.equal(window.document.activeElement, copy, "the local command is ready to copy on open");
    const write = t.mock.method(window.navigator.clipboard, "writeText", async () => { throw new Error("denied"); });
    await act(async () => copy.click());
    assert.deepEqual(write.mock.calls[0].arguments, [command]);
    const status = () => [...dialog.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ");
    assert.match(status(), /Couldn't copy/);
    assert.equal(window.document.activeElement, copy);

    write.mock.mockImplementation(async () => {});
    await act(async () => copy.click());
    assert.equal(write.mock.callCount(), 2);
    assert.deepEqual(write.mock.calls[1].arguments, [command]);
    assert.match(status(), /Copied\./);

    const close = [...container.querySelectorAll("dialog button")].find((button) => button.textContent === "Close");
    assert.ok(close);
    await act(async () => close.click());
    assert.equal(container.querySelector("dialog"), null);
    await act(async () => root.render(React.createElement(RunConsole, {
      snapshot: { ...snapshot, actions: [] }, streamState: "closed", compact,
    })));
    assert.doesNotMatch(container.textContent, /Run again|Retry/);
  });
}

for (const mode of ["practice", "official"] as const) {
  for (const compact of [false, true]) {
    test(`${mode} Retry in compact=${compact} binds one request and preserves focus and history`, async (t) => {
      const snapshot = retrySnapshot(mode);
      const requests: RunSurfaceMutationInput[] = [];
      const opened: string[] = [];
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const onAction = async (input: RunSurfaceMutationInput) => { requests.push(input); await pending; };
      const element = (value = snapshot, busy = false) => React.createElement(RunConsole, {
        snapshot: value, streamState: "closed", compact, onAction,
        busyAction: busy ? "retry" : null, onOpenRun: (id: string) => { opened.push(id); },
      });
      const { container, root, window } = await mount(t, element());
      const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
      assert.ok(retry, "submission-runtime categories must not suppress server-eligible Retry");
      retry.focus();
      await act(async () => { retry.click(); retry.click(); });
      assert.deepEqual(requests, [{ surfaceId: snapshot.id, action: "retry", runId: "physical_failed" }]);
      await act(async () => root.render(element(snapshot, true)));
      assert.equal(retry.disabled, false);
      assert.equal(retry.getAttribute("aria-disabled"), "true");
      assert.equal(window.document.activeElement, retry);
      await act(async () => retry.click());
      assert.equal(requests.length, 1);
      const next = RunSurfaceSnapshotSchema.parse({
        ...snapshot, status: "running", phase: "queued", executionGeneration: 2, actions: [],
        practiceRunId: mode === "practice" ? "physical_retry" : snapshot.practiceRunId,
        officialRunId: mode === "official" ? "physical_retry" : null,
        executionHistory: [...snapshot.executionHistory, { id: "physical_retry", mode, status: "queued", retryOfRunId: "physical_failed", createdAt: 9000, finishedAt: null }],
      });
      await act(async () => { root.render(element(next)); release(); await pending; });
      assert.equal(window.document.activeElement, container.querySelector("h1"));
      assert.doesNotMatch(container.textContent, /Submission stopped during evaluation/);
      const history = container.querySelector('[aria-label="Run history"]');
      assert.ok(history?.closest('[aria-hidden="true"][inert]'));
      const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show run history");
      assert.ok(toggle);
      toggle.focus();
      await act(async () => toggle.click());
      assert.equal(history.closest('[aria-hidden="true"]'), null);
      const detail = [...history.querySelectorAll("button")][0];
      assert.ok(detail);
      await act(async () => detail.click());
      assert.deepEqual(opened, ["physical_failed"]);
      await act(async () => root.render(element({ ...next, updatedAt: 10000 })));
      assert.equal(window.document.activeElement, toggle, "live updates must not move unrelated focus");
    });
  }
}

test("server refusal keeps recovery absent and physical details link only to recorded consoles", async (t) => {
  const snapshot = { ...retrySnapshot(), actions: [], sourceRefusal: "The recorded repository is no longer connected." };
  const { container } = await mount(t, React.createElement(RunConsole, { snapshot, streamState: "closed", onAction: async () => { throw new Error("must not run"); } }));
  assert.doesNotMatch(container.textContent, /Retry|Run again|Rerun hosted/);
  assert.match(container.textContent, /no longer connected/);
});

for (const surfaceId of [null, `surface_${"a".repeat(20)}`]) {
  test(`physical history uses nullable recorded surfaceId=${surfaceId}`, async (t) => {
    const { container } = await mount(t, page(t, run({ surfaceId })));
    const link = [...container.querySelectorAll("a")].find((node) => node.textContent === "Open current run");
    assert.equal(link?.getAttribute("href") ?? null, surfaceId ? `/run-surfaces/${surfaceId}` : null);
  });
}

test("console route sends the failed run ID, retains rejected Retry focus, and accepts one successor", async (t) => {
  const snapshot = retrySnapshot();
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  client.setQueryData(["run-surface", snapshot.id], snapshot);
  class Socket extends EventTarget { close() { this.dispatchEvent(new Event("close")); } }
  const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  const previousFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let resolveResponse!: (response: Response) => void;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `/api/run-surfaces/${snapshot.id}/actions/retry`);
    assert.ok(init);
    requests.push(init);
    return new Promise<Response>((resolve) => { resolveResponse = resolve; });
  };
  t.after(() => {
    client.clear();
    globalThis.fetch = previousFetch;
    if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  const { container, window } = await mount(t,
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [`/run-surfaces/${snapshot.id}`] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/run-surfaces/:surfaceId", element: React.createElement(RunSurfacePage) })))));
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
  assert.ok(retry);
  retry.focus();
  await act(async () => { retry.click(); retry.click(); });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(requests[0].body)), { runId: "physical_failed" });
  await act(async () => {
    resolveResponse(Response.json({ error: { code: "active_run_exists", message: "Another run is already active." } }, { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector('[role="alert"]')?.textContent, "Another run is already active.");
  assert.equal(window.document.activeElement, retry);
  assert.equal(retry.getAttribute("aria-disabled"), "false");
  await act(async () => retry.click());
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(String(requests[1].body)), { runId: "physical_failed" });
  const next = RunSurfaceSnapshotSchema.parse({
    ...snapshot, status: "running", phase: "queued", executionGeneration: 2, finishedAt: null,
    practiceRunId: "physical_retry", actions: [],
    executionHistory: [...snapshot.executionHistory, {
      id: "physical_retry", mode: "practice", status: "queued",
      retryOfRunId: "physical_failed", createdAt: 9000, finishedAt: null,
    }],
  });
  await act(async () => {
    resolveResponse(Response.json(next));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The cache changes before Query's scheduled observer notification commits the
  // successor. Wait for that render, not just the response's first timer turn.
  const renderDeadline = Date.now() + 1_000;
  while (retry.isConnected && Date.now() < renderDeadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  assert.ok(!retry.isConnected, "the successor render removes the failed execution's Retry button");
  assert.equal(client.getQueryData<typeof snapshot>(["run-surface", snapshot.id])?.practiceRunId, "physical_retry");
  assert.equal(container.querySelector('[role="alert"]'), null);
  // Compare identity without asking Node to format Happy DOM's cyclic object
  // graph if focus is wrong; the object diff can obscure the assertion failure.
  assert.ok(window.document.activeElement === container.querySelector("h1"), "the successor heading receives Retry focus");
  assert.equal(container.querySelector("h1")?.textContent, snapshot.benchmark.title);
});

test("live hook rejects old generations, old responses and closed-console frames", async (t) => {
  class Socket extends EventTarget {
    static opened: Socket[] = [];
    constructor(readonly url: string) { super(); Socket.opened.push(this); }
    close() { this.dispatchEvent(new Event("close")); }
    frame(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor); else Reflect.deleteProperty(globalThis, "WebSocket"); });
  const first = retrySnapshot();
  function Probe({ initial }: { initial: typeof first }) {
    const { snapshot } = useRunSurfaceStream(initial, `/api/run-surfaces/${initial.id}/stream`);
    return React.createElement("output", null, JSON.stringify(snapshot));
  }
  const { container, root } = await mount(t, React.createElement(Probe, { initial: first }));
  const current = () => RunSurfaceSnapshotSchema.parse(JSON.parse(container.textContent));
  const socket = Socket.opened[0];
  const next = { ...first, status: "running" as const, phase: "queued", executionGeneration: 2, snapshotRevision: 2, practiceRunId: "physical_retry", actions: [] };
  await act(async () => { root.render(React.createElement(Probe, { initial: next })); });
  await act(async () => socket.frame({ ...first, updatedAt: 99999 }));
  assert.equal(current().practiceRunId, "physical_retry");
  await act(async () => root.render(React.createElement(Probe, { initial: { ...first, updatedAt: 99999 } })));
  assert.equal(current().executionGeneration, 2);
  const evaluating = { ...next, phase: "evaluating", snapshotRevision: 3 };
  await act(async () => socket.frame(evaluating));
  await act(async () => socket.frame(next));
  assert.equal(current().phase, "evaluating", "equal timestamps cannot roll back a newer revision");
  await act(async () => root.render(React.createElement(Probe, { initial: next })));
  assert.equal(current().snapshotRevision, 3, "a stale query response cannot replace a live revision");
  const done = { ...evaluating, status: "succeeded" as const, updatedAt: 12000, snapshotRevision: 4 };
  await act(async () => socket.frame(done));
  await act(async () => socket.frame({ ...next, updatedAt: 13000 }));
  assert.equal(current().status, "succeeded");
  await act(async () => socket.frame({ ...done, updatedAt: 11000, branch: "wrong" }));
  assert.equal(current().branch, "detached");
  const published = { ...done, published: true, snapshotRevision: 5 };
  await act(async () => socket.frame(published));
  await act(async () => socket.frame(done));
  assert.equal(current().published, true);
  await act(async () => socket.frame({ ...done, snapshotRevision: 6 }));
  assert.equal(current().published, false, "a newer revision can deselect the same successful run");
  const other = { ...first, id: `surface_${"c".repeat(20)}` };
  await act(async () => root.render(React.createElement(Probe, { initial: other })));
  await act(async () => socket.frame({ ...done, executionGeneration: 99 }));
  assert.equal(current().id, other.id);
});

/**
 * Publishing a run whose repository the team has left.
 *
 * `publishable` stays a fact about the run: it is what keeps history readable
 * and an existing public entry intact after a repository change. The server
 * refuses only a *new* publication (`requireRunSource` in
 * services/run-actions.ts), and this panel used to offer one anyway.
 */

function official(overrides: Partial<RunDetail> = {}): RunDetail {
  return run({
    id: "run_official_123", mode: "official", status: "succeeded",
    failure: null, log: null, attemptNumber: 1, publishable: true,
    ...overrides,
  });
}

const LEFT_REPOSITORY =
  "This run came from a repository your team is no longer connected to. Start a fresh run on course/team to publish a result.";

test("an official run from a repository the team left offers no publication", async (t) => {
  const { container } = await mount(t, page(t, official({ sourceRefusal: LEFT_REPOSITORY })));
  assert.match(container.textContent, /no longer connected to/);
  // The button and the promise beside it both go: the server would refuse it.
  assert.equal([...container.querySelectorAll("button")]
    .some((node) => node.textContent.includes("Publish to leaderboard")), false);
  assert.doesNotMatch(container.textContent, /switch to another successful official run/);
});

test("the same run still offers publication while its repository matches", async (t) => {
  const { container } = await mount(t, page(t, official()));
  assert.ok([...container.querySelectorAll("button")]
    .some((node) => node.textContent.includes("Publish to leaderboard")));
  assert.match(container.textContent, /switch to another successful official run/);
});

test("a result already published keeps saying so after the repository changes", async (t) => {
  // The refusal is about making a new selection. Replacing this sentence with
  // it would tell a team their public entry is gone when it is still up.
  const { container } = await mount(t, page(t, official({ selected: true, sourceRefusal: LEFT_REPOSITORY })));
  assert.match(container.textContent, /public entry/);
  assert.match(container.textContent, /See it on the leaderboard/);
  assert.doesNotMatch(container.textContent, /no longer connected to/);
});
