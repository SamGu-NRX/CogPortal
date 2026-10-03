import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { MotionConfig } from "motion/react";
import {
  BenchmarkSchema,
  DashboardSchema,
  RunSummarySchema,
  type Benchmark,
  type Dashboard,
  type RunSummary,
} from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { RunList } from "../src/components/RunList.tsx";
import { TrackSwitcher } from "../src/components/TrackSwitcher.tsx";
import { runTitle } from "../src/lib/run-meta.ts";
import { DashboardPage, Marked } from "../src/routes/DashboardPage.tsx";

/**
 * The Runs page names runs in words and says what a finished run cost. Both
 * are claims a student acts on (which run to open, whether a failure spent
 * an attempt), so they are pinned here against the payload that drives them.
 */

function benchmark(id: string, module: Benchmark["module"], title: string): Benchmark {
  return BenchmarkSchema.parse({
    id,
    version: 1,
    contractVersion: "cogworks.submissions.v2",
    entryPointName: id,
    title,
    module,
    summary: `${title} summary.`,
    active: true,
    pluginVersion: "0.1.0",
    datasetVersion: "d1",
    scorerVersion: "s1",
    runtimeVersion: "week3-cpu-v1",
  });
}

const LANGUAGE = benchmark("language-search", "language", "Semantic Image Search");
const VISION = benchmark("vision-recognition", "vision", "Recognition");

function run(overrides: Partial<RunSummary> & { id: string }): RunSummary {
  return RunSummarySchema.parse({
    repo: { owner: "demo", name: "repo", fullName: "demo/repo", url: "https://github.com/demo/repo" },
    mode: "practice",
    status: "succeeded",
    benchmarkId: LANGUAGE.id,
    benchmarkVersion: 1,
    branch: "main",
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    createdAt: Date.now() - 120_000,
    finishedAt: Date.now() - 60_000,
    attemptNumber: null,
    primaryMetric: {
      key: "overall", label: "Overall", value: 0.4428, unit: null,
      higherIsBetter: true, primary: true, precision: 3,
    },
    failure: null,
    ...overrides,
  });
}

function dashboard(runs: RunSummary[], extra: Partial<Dashboard> = {}): Dashboard {
  return DashboardSchema.parse({
    benchmark: LANGUAGE,
    team: {
      id: "team_1", name: "Analytical Engines", description: null, provenance: "live",
      repo: {
        owner: "demo", name: "repo", fullName: "demo/repo",
        url: "https://github.com/demo/repo", defaultBranch: "main",
      },
    },
    quota: { practiceUsed: 1, practiceLimit: 10, officialUsed: 0, officialLimit: 3 },
    lastResolvedSha: runs[0]?.sha ?? null,
    activeRun: null,
    latestCandidate: null,
    selection: null,
    runs,
    ...extra,
  });
}

/** The session's view of the team, which the page's label is drawn from. */
function sessionOn(teamId: string, name = "Analytical Engines") {
  return {
    user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "test", name: "Test" },
    team: { id: teamId, name, description: null, provenance: "live", repo: null },
    auth: { executionProvider: "fixture" },
  };
}

function render(d: Dashboard, location = "/dashboard", tracks: Benchmark[] = [LANGUAGE]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["session"], sessionOn(d.team.id));
  client.setQueryData(["benchmarks"], tracks);
  for (const track of tracks) client.setQueryData(["dashboard", track.id], { ...d, benchmark: track });
  client.setQueryData(["local-reports", d.benchmark.id], []);
  client.setQueryData(["untracked-local-reports"], []);
  client.setQueryData(["repositories"], []);
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client },
      React.createElement(StaticRouter, { location }, React.createElement(DashboardPage))),
  );
}

test("a run's title names its kind and branch, or the commit when it ran detached", () => {
  assert.equal(runTitle({ mode: "practice", attemptNumber: null, branch: "main", shortSha: "abc1234" }), "Practice run on main");
  assert.equal(runTitle({ mode: "official", attemptNumber: 2, branch: "improved", shortSha: "abc1234" }), "Official attempt #2 on improved");
  assert.equal(runTitle({ mode: "official", attemptNumber: null, branch: "main", shortSha: "abc1234" }), "Official attempt on main");
  assert.equal(runTitle({ mode: "practice", attemptNumber: null, branch: "detached", shortSha: "abc1234" }), "Practice run on commit abc1234");
});

test("each history row opens its run, keeps the tag, and marks only the published run", () => {
  const runs = [
    run({ id: "run_0000000001", mode: "official", attemptNumber: 1, branch: "improved" }),
    run({ id: "run_0000000002", branch: "improved" }),
  ];
  const html = renderToStaticMarkup(
    React.createElement(StaticRouter, { location: "/dashboard" },
      React.createElement(RunList, { runs, connectedFullName: "demo/repo", publishedRunId: "run_0000000001" })),
  );
  assert.match(html, /href="\/runs\/run_0000000001"[\s\S]*Official attempt #1 on improved[\s\S]*Run #0001 · aaaaaaa[\s\S]*on the leaderboard/);
  assert.match(html, /href="\/runs\/run_0000000002"[\s\S]*Practice run on improved/);
  assert.equal(html.split("on the leaderboard").length - 1, 1);
  // The number says what it is to a screen reader, not only through the
  // column head drawn for sighted readers.
  assert.match(html, /<span class="sr-only">Overall <\/span>0\.443/);
});

test("a history that mixes measures names each row's own, never the first row's", () => {
  // A partial Language run leads with text MRR. Labeling the column "Overall"
  // from the first row would call its 0.950 an overall.
  const runs = [
    run({ id: "run_0000000001" }),
    run({ id: "run_0000000002", primaryMetric: {
      key: "text_mrr", label: "Text MRR", value: 0.95, unit: null, higherIsBetter: true, primary: true, precision: 3,
    } }),
  ];
  const list = (items: RunSummary[]) => renderToStaticMarkup(
    React.createElement(StaticRouter, { location: "/dashboard" }, React.createElement(RunList, { runs: items })),
  );
  const mixed = list(runs);
  assert.match(mixed, /<span class="u-kicker text-right">Reading<\/span>/);
  assert.match(mixed, /<span class="sr-only">Overall <\/span>0\.443<span aria-hidden="true"[^>]*>Overall<\/span>/);
  assert.match(mixed, /<span class="sr-only">Text MRR <\/span>0\.950<span aria-hidden="true"[^>]*>Text MRR<\/span>/);

  // One measure throughout: the column head says it once and rows stay bare.
  const uniform = list([runs[0]]);
  assert.match(uniform, /<span class="u-kicker text-right">Overall<\/span>/);
  assert.doesNotMatch(uniform, /aria-hidden="true"[^>]*>Overall</);
});

test("a failed practice run says what failed and that it cost nothing", () => {
  const failed = run({
    id: "run_00000000f1",
    status: "failed",
    branch: "null-descriptor",
    primaryMetric: null,
    failure: { category: "student_runtime", phase: "evaluating", detail: "ValueError in embed_text", consumedAttempt: false },
  });
  const html = render(dashboard([failed]));
  assert.match(html, /Latest run[\s\S]*Practice run on null-descriptor/);
  assert.match(html, /The evaluation stopped on an exception\./);
  assert.match(html, /ValueError in embed_text/);
  assert.match(html, /Stopped at Evaluate [^.]*\. Failed runs don&#x27;t use your hosted budget\./);
  assert.match(html, /See what went wrong/);
});

test("an official failure states whether it used the attempt, from the server's own flag", () => {
  for (const consumedAttempt of [true, false]) {
    const failed = run({
      id: "run_00000000f2", mode: "official", attemptNumber: 2, status: "failed", primaryMetric: null,
      failure: { category: "timeout", phase: "evaluating", detail: null, consumedAttempt },
    });
    const html = render(dashboard([failed]));
    if (consumedAttempt) assert.match(html, /It used official attempt #2\./);
    else assert.match(html, /It didn&#x27;t use an official attempt\./);
    assert.doesNotMatch(html, /hosted budget/);
  }
});

test("a live run replaces the launcher, so nothing offers a second start", () => {
  const live = run({ id: "run_00000000a1", status: "evaluating", finishedAt: null, primaryMetric: null });
  const html = render(dashboard([live], { activeRun: live }));
  assert.match(html, /Running now/);
  assert.match(html, /aria-label="Run pipeline"/);
  assert.match(html, /Runs go one at a time on each benchmark/);
  assert.doesNotMatch(html, /Run practice benchmark/);
  assert.doesNotMatch(html, /Promote to official/);
});

test("spent practice runs leave the local command, not a dead end", () => {
  const html = render(dashboard([run({ id: "run_0000000003" })], {
    quota: { practiceUsed: 10, practiceLimit: 10, officialUsed: 0, officialLimit: 3 },
  }));
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /All 10 hosted practice runs on this version are used/);
  assert.match(html, /cogworks run --benchmark language-search/);
});

test("?benchmark= opens that track on the first render", () => {
  const html = render(dashboard([run({ id: "run_0000000004" })]), "/dashboard?benchmark=vision-recognition", [VISION, LANGUAGE]);
  assert.match(html, /<h1[^>]*>Recognition/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Recognition/);
  assert.match(html, /role="tabpanel"[^>]*aria-labelledby="track-tab-vision-recognition"/);
});

/* ── Track tabs, driven with a keyboard ───────────────────────────────── */

async function mountTabs(t: TestContext, onSelect: (id: string) => void) {
  const window = new Window({ url: "https://portal.example/dashboard" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React DOM uses here.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const clustering = { ...VISION, id: "vision-clustering", title: "Clustering" };
  function Harness() {
    const [selected, setSelected] = React.useState(LANGUAGE.id);
    const tracks = [clustering, VISION, LANGUAGE];
    return React.createElement(TrackSwitcher, {
      variant: "tabs",
      tracks,
      benchmark: tracks.find((track) => track.id === selected),
      onSelect: (id: string) => { onSelect(id); setSelected(id); },
      panelId: "panel",
    });
  }
  await act(async () => root.render(React.createElement(Harness)));
  return { window, container };
}

test("track tabs: arrows move focus without selecting, activating selects, focus stays put", async (t) => {
  const selected: string[] = [];
  const { window, container } = await mountTabs(t, (id) => selected.push(id));
  const tabs = () => [...container.querySelectorAll('[role="tab"]')] as unknown as HTMLElement[];
  const key = (k: string) => act(async () => {
    window.document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

  // One tab stop: only the selected tab is in the Tab order.
  assert.deepEqual(tabs().map((tab) => tab.getAttribute("tabindex")), ["-1", "-1", "0"]);
  assert.equal(tabs()[2]!.getAttribute("aria-controls"), "panel");
  tabs()[2]!.focus();

  await key("ArrowRight");
  assert.equal(window.document.activeElement, tabs()[0], "ArrowRight wraps to the first tab");
  await key("ArrowRight");
  assert.equal(window.document.activeElement, tabs()[1]);
  await key("End");
  assert.equal(window.document.activeElement, tabs()[2]);
  await key("Home");
  assert.equal(window.document.activeElement, tabs()[0]);
  await key("ArrowLeft");
  assert.equal(window.document.activeElement, tabs()[2], "ArrowLeft wraps to the last tab");
  assert.deepEqual(selected, [], "moving focus loads nothing");

  await key("ArrowLeft");
  // A native button turns Enter and Space into this click.
  await act(async () => (window.document.activeElement as unknown as HTMLElement).click());
  assert.deepEqual(selected, [VISION.id]);
  assert.equal(window.document.activeElement, tabs()[1]);
  assert.equal(tabs()[1]!.getAttribute("aria-selected"), "true");
  assert.deepEqual(tabs().map((tab) => tab.getAttribute("tabindex")), ["-1", "0", "-1"]);

  // Pressing the tab already selected does not reload it.
  await act(async () => tabs()[1]!.click());
  assert.deepEqual(selected, [VISION.id]);
});

test("the finished-run highlighter starts fully drawn under reduced motion", () => {
  // The first rendered frame, not the end state: both modes end at scaleX(1),
  // so only the starting frame shows whether a draw would run. "never" proves
  // the check can tell the two apart.
  const stroke = (reducedMotion: "always" | "never") =>
    renderToStaticMarkup(
      React.createElement(MotionConfig, { reducedMotion },
        React.createElement(Marked, null, "Finished just now.")),
    ).match(/<span aria-hidden="true"[^>]*>/)?.[0] ?? "";

  assert.match(stroke("always"), /transform:scaleX\(1\)/);
  assert.match(stroke("never"), /transform:scaleX\(0\)/);
});


/** Identity, reported by tag and text: assert.equal on two DOM nodes formats
 *  both whole graphs on failure, which can stall the runner. */
function assertFocused(actual: Element | null | undefined, expected: Element | null | undefined, message: string) {
  const describe = (node: Element | null | undefined) => (node ? `${node.tagName} "${node.textContent?.trim().slice(0, 40)}"` : String(node));
  assert.ok(actual === expected, `${message}: focus is on ${describe(actual)}, expected ${describe(expected)}`);
}

/* ── Focus when the lead run changes under it ─────────────────────────── */

async function mountDashboard(t: TestContext, first: Dashboard, session = sessionOn(first.team.id)) {
  const window = new Window({ url: "https://portal.example/dashboard" });
  const requests: Array<{ url: string; body: unknown }> = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element,
    React, IS_REACT_ACT_ENVIRONMENT: true,
    // A live run polls the dashboard; the test drives every answer through
    // the cache instead, so a poll fails at once and the data stays.
    fetch: async (input: string, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      throw new Error("no network in this test");
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["session"], session);
  client.setQueryData(["benchmarks"], [LANGUAGE]);
  client.setQueryData(["dashboard", LANGUAGE.id], first);
  client.setQueryData(["local-reports", LANGUAGE.id], []);
  client.setQueryData(["untracked-local-reports"], []);
  client.setQueryData(["repositories"], []);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React DOM uses here.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: ["/dashboard"] }, React.createElement(DashboardPage))),
  ));
  // The query cache tells its observers on a zero-delay timer, so the
  // re-render lands only after a macrotask.
  const replace = (next: Dashboard) => act(async () => {
    client.setQueryData(["dashboard", LANGUAGE.id], next);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { window, container, replace, requests };
}

const buttonOrLink = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button, a")].find((node) => node.textContent?.trim() === name);
  assert.ok(found, `nothing named ${name}`);
  return found as HTMLElement;
};

test("starting, finishing and promoting a run keep focus on the lead run instead of the page", async (t) => {
  const done = run({ id: "run_0000000010" });
  const { window, container, replace } = await mountDashboard(t, dashboard([done]));
  const leadTitle = () => container.querySelector<HTMLElement>("[data-lead-title]");

  // The launcher's button goes when the run it started becomes the live lead.
  buttonOrLink(container, "Run practice benchmark").focus();
  const live = run({ id: "run_0000000011", status: "evaluating", finishedAt: null, primaryMetric: null });
  await replace(dashboard([live, done], { activeRun: live }));
  assertFocused(window.document.activeElement, leadTitle(), "focus");
  assert.equal(leadTitle()?.textContent, "Practice run on main");

  // The live card is replaced by the finished one.
  buttonOrLink(container, "Open the run").focus();
  const finished = { ...live, status: "succeeded" as const, finishedAt: Date.now(), primaryMetric: done.primaryMetric };
  await replace(dashboard([finished, done], { latestCandidate: { ...finished, sourceRefusal: null, promotedTo: null } }));
  assertFocused(window.document.activeElement, leadTitle(), "focus");

  // Promotion's confirm goes when the official attempt it started leads.
  buttonOrLink(container, "Promote to official").click();
  await act(async () => {});
  const confirm = [...container.querySelectorAll("button")].find((node) => /^Confirm, uses attempt 1/.test(node.textContent ?? ""));
  assert.ok(confirm);
  confirm.focus();
  const official = run({ id: "run_0000000012", mode: "official", attemptNumber: 1, status: "queued", finishedAt: null, primaryMetric: null });
  await replace(dashboard([official, finished, done], { activeRun: official }));
  assertFocused(window.document.activeElement, leadTitle(), "focus");
  assert.equal(leadTitle()?.textContent, "Official attempt #1 on main");
});

test("a launcher removed after focus already left it doesn't pull focus back", async (t) => {
  const done = run({ id: "run_0000000030" });
  const { window, container, replace } = await mountDashboard(t, dashboard([done]));
  const launch = buttonOrLink(container, "Run practice benchmark");
  launch.focus();
  // A click on plain text, or a run started from the CLI while reading elsewhere.
  await act(async () => { launch.blur(); });
  const live = run({ id: "run_0000000031", status: "evaluating", finishedAt: null, primaryMetric: null });
  await replace(dashboard([live, done], { activeRun: live }));
  assert.equal(launch.isConnected, false);
  assertFocused(window.document.activeElement, window.document.body, "focus the student moved away stays away");
});

test("a lead run that changes doesn't take focus from a control that is still there", async (t) => {
  const done = run({ id: "run_0000000020" });
  const { window, container, replace } = await mountDashboard(t, dashboard([done]));
  const row = container.querySelector<HTMLElement>('[aria-labelledby="history-heading"] a[href="/runs/run_0000000020"]');
  assert.ok(row);
  row.focus();
  const live = run({ id: "run_0000000021", status: "evaluating", finishedAt: null, primaryMetric: null });
  await replace(dashboard([live, done], { activeRun: live }));
  assertFocused(window.document.activeElement, row, "focus");
});

test("with the session on one team and the dashboard on another, nothing offers a start", async (t) => {
  // The label comes from the session, the start from the dashboard, and the
  // server takes whichever team the cookie says now: the student could not
  // see where a run would land (B-71 audit).
  const onB = dashboard([], { team: { ...dashboard([]).team, id: "team_b", name: "Difference Engines" } });
  const { window, container, requests } = await mountDashboard(t, onB, sessionOn("team_a", "Analytical Engines"));
  const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
  assert.ok(!buttons.includes("Run practice benchmark"), "a start was offered across two teams");
  assert.match(container.textContent ?? "", /This page is out of date and can't tell which team a run would start on\. Reload it\s+first\./);
  let reloaded = 0;
  Object.defineProperty(window.location, "reload", { configurable: true, value: () => { reloaded += 1; } });
  await act(async () => buttonOrLink(container, "Reload page").click());
  assert.equal(reloaded, 1);
  assert.equal(requests.filter((r) => r.url.includes("/api/runs/practice")).length, 0, "a start request was sent");
});

test("with the session and dashboard on the same team, the start sends that team", async (t) => {
  const { container, requests } = await mountDashboard(t, dashboard([]));
  await act(async () => buttonOrLink(container, "Run practice benchmark").click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const start = requests.find((r) => r.url.includes("/api/runs/practice"));
  assert.deepEqual((start?.body as { teamId?: string } | undefined)?.teamId, "team_1");
});
