import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
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

function render(d: Dashboard, location = "/dashboard", tracks: Benchmark[] = [LANGUAGE]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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
  assert.match(html, /Your code raised an exception\./);
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
