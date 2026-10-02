import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Benchmark } from "@cogworks/contracts/schema";
import { LeaderboardPage } from "../src/routes/LeaderboardPage.tsx";

/**
 * A published result links to the leaderboard with its benchmark. The link
 * used to be bare, so a published Vision Recognition result opened on Audio
 * with no sign of the entry the student had just made public.
 */

function benchmark(id: string, module: Benchmark["module"], title: string): Benchmark {
  return {
    id, version: 1, contractVersion: "cogworks.submissions.v1", entryPointName: id, title, module,
    summary: title, active: true, pluginVersion: "1", datasetVersion: "official-v1", scorerVersion: "1",
    runtimeVersion: "python-3.8",
  };
}

const CATALOG = [
  benchmark("audio-identification", "audio", "Song Identification"),
  benchmark("vision-recognition", "vision", "Recognition"),
  benchmark("vision-clustering", "vision", "Clustering"),
  benchmark("language-search", "language", "Semantic Search"),
];

type Container = ReturnType<Window["document"]["createElement"]>;

async function settle(until: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (until()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  assert.fail(`the DOM never reached: ${what}`);
}

/** The Vision Overall board as it reads before any team has published both
 *  components from one commit. */
const EMPTY_OVERALL = {
  family: {
    id: "vision-overall", version: 1, title: "Vision overall", module: "vision", active: true,
    components: [
      { key: "recognition", label: "Recognition", benchmarkId: "vision-recognition", benchmarkVersion: 1, metricKey: "f1", weight: 1 },
      { key: "clustering", label: "Clustering", benchmarkId: "vision-clustering", benchmarkVersion: 1, metricKey: "ari", weight: 1 },
    ],
  },
  entries: [],
};

/** Mounts the page at `path`. The catalog request waits for `releaseCatalog`,
 *  so a test can look at the page before the module is known. Standings
 *  requests never answer unless `answerOverall` is set; only the tabs are
 *  under test. */
async function mount(t: TestContext, path: string, answerOverall = false) {
  const window = new Window({ url: `https://portal.example${path}` });
  let releaseCatalog: (catalog: Benchmark[] | null) => void = () => undefined;
  let catalogRequests = 0;
  const fetch = async (input: string) => {
    if (input === "/api/benchmarks") {
      catalogRequests += 1;
      const catalog = await new Promise<Benchmark[] | null>((resolve) => { releaseCatalog = resolve; });
      if (catalog === null) return Response.json({ error: { code: "internal", message: "Catalog unavailable." } }, { status: 500 });
      return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (answerOverall && input.startsWith("/api/leaderboard-family")) return Response.json(EMPTY_OVERALL);
    return new Promise<Response>(() => undefined);
  };
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true, fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/leaderboard", element: React.createElement(LeaderboardPage) }], {
    initialEntries: [path],
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
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
    React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })),
  ));
  await settle(() => catalogRequests === 1, "the catalog request");

  const selected = (list: string) =>
    [...container.querySelectorAll(`[aria-label="${list}"] [role="tab"][aria-selected="true"]`)]
      .map((tab) => (tab.textContent ?? "").replace(/in progress/, "").trim());
  const tab = (list: string, name: string) => {
    const found = [...container.querySelectorAll(`[aria-label="${list}"] [role="tab"]`)]
      .find((node) => (node.textContent ?? "").replace(/in progress/, "").trim() === name);
    assert.ok(found, `${list} has a ${name} tab`);
    return found as unknown as HTMLElement;
  };
  const answerCatalog = async (catalog = CATALOG) => {
    releaseCatalog(catalog);
    await settle(() => client.getQueryState(["benchmarks"])?.status === "success" && selected("Benchmark track").length === 1, "the catalog to render");
  };
  const reachableTabs = () =>
    [...container.querySelectorAll('[aria-label="Benchmark track"] [role="tab"]')]
      .filter((node) => node.getAttribute("tabindex") === "0")
      .map((node) => (node.textContent ?? "").replace(/in progress/, "").trim());
  return {
    container, client, router, selected, answerCatalog, window, reachableTabs,
    failCatalog: async () => {
      releaseCatalog(null);
      await settle(
        () => client.getQueryState(["benchmarks"])?.status === "error" && /Try again|Retry/i.test(container.textContent ?? ""),
        "the catalog failure to render",
      );
    },
    click: async (list: string, name: string) => {
      await act(async () => tab(list, name).click());
    },
    navigate: async (to: string) => {
      await act(async () => router.navigate(to));
    },
    back: async () => {
      await act(async () => router.navigate(-1));
    },
    refetchCatalog: async () => {
      let refetch: Promise<void> = Promise.resolve();
      await act(async () => {
        refetch = client.refetchQueries({ queryKey: ["benchmarks"] });
      });
      await settle(() => catalogRequests === 2, "the catalog refetch");
      releaseCatalog([...CATALOG]);
      await act(async () => {
        await refetch;
      });
    },
  };
}

test("a published Recognition result opens the Vision track on its own tab", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=vision-recognition");
  // No module is known before the catalog answers, and guessing the first one
  // would show Audio and then jump.
  assert.deepEqual(page.selected("Benchmark track"), []);
  await page.answerCatalog();
  assert.deepEqual(page.selected("Benchmark track"), ["Vision"]);
  assert.deepEqual(page.selected("Vision leaderboard"), ["Recognition"]);
});

test("the bare leaderboard opens on the first open track in course order", async (t) => {
  const page = await mount(t, "/leaderboard");
  // Which track is open is in the catalog, so no tab is chosen before it answers.
  assert.deepEqual(page.selected("Benchmark track"), []);
  await page.answerCatalog();
  assert.deepEqual(page.selected("Benchmark track"), ["Audio"]);
  await page.click("Benchmark track", "Vision");
  assert.deepEqual(page.selected("Vision leaderboard"), ["Overall"]);
});

test("a bare leaderboard skips a track still in progress", async (t) => {
  const page = await mount(t, "/leaderboard");
  await page.answerCatalog(CATALOG.map((entry) => (entry.module === "audio" ? { ...entry, active: false } : entry)));
  assert.deepEqual(page.selected("Benchmark track"), ["Vision"]);
  // The in-progress track is still one press away.
  await page.click("Benchmark track", "Audio");
  assert.deepEqual(page.selected("Benchmark track"), ["Audio"]);
});

test("a tab the reader picks survives a catalog refetch, and a new link replaces it", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=vision-recognition");
  await page.answerCatalog();
  await page.click("Vision leaderboard", "Clustering");
  await page.click("Benchmark track", "Language");
  await page.click("Benchmark track", "Vision");
  assert.deepEqual(page.selected("Vision leaderboard"), ["Clustering"]);

  await page.refetchCatalog();
  assert.deepEqual(page.selected("Benchmark track"), ["Vision"]);
  assert.deepEqual(page.selected("Vision leaderboard"), ["Clustering"]);

  await page.navigate("/leaderboard?benchmark=audio-identification");
  assert.deepEqual(page.selected("Benchmark track"), ["Audio"]);
  await page.navigate("/leaderboard?benchmark=vision-recognition");
  assert.deepEqual(page.selected("Vision leaderboard"), ["Recognition"]);
});

test("an unknown benchmark falls back to the default rather than an empty page", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=retired-benchmark");
  await page.answerCatalog();
  assert.deepEqual(page.selected("Benchmark track"), ["Audio"]);
});

test("Back resets a manual tab to the benchmark requested by the returning link", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=vision-recognition");
  await page.answerCatalog();
  await page.click("Vision leaderboard", "Clustering");
  assert.deepEqual(page.selected("Vision leaderboard"), ["Clustering"]);

  await page.navigate("/leaderboard?benchmark=audio-identification");
  assert.deepEqual(page.selected("Benchmark track"), ["Audio"]);
  await page.back();
  assert.deepEqual(page.selected("Benchmark track"), ["Vision"]);
  assert.deepEqual(page.selected("Vision leaderboard"), ["Recognition"]);
});

test("an empty Overall board offers each component board one press away", async (t) => {
  const page = await mount(t, "/leaderboard", true);
  await page.answerCatalog(CATALOG.map((entry) => (entry.module === "audio" ? { ...entry, active: false } : entry)));
  assert.deepEqual(page.selected("Vision leaderboard"), ["Overall"]);
  await settle(() => /See Recognition/.test(page.container.textContent ?? ""), "the empty Overall board");

  const see = [...page.container.querySelectorAll("button")].find((button) => button.textContent === "See Clustering");
  assert.ok(see);
  await act(async () => (see as unknown as HTMLElement).click());
  assert.deepEqual(page.selected("Vision leaderboard"), ["Clustering"]);
  // The button left with the empty state; focus is on the tab it chose.
  const focused = page.window.document.activeElement;
  assert.ok(focused?.id === "vision-tab-clustering", `focus is on ${focused?.id || focused?.tagName}`);
});

test("the track row keeps one Tab stop while the catalog is still answering", async (t) => {
  const page = await mount(t, "/leaderboard");
  assert.deepEqual(page.selected("Benchmark track"), []);
  assert.deepEqual(page.reachableTabs(), ["Audio"]);
});

test("an unknown benchmark opens the first open track, not one in progress", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=retired-benchmark");
  await page.answerCatalog(CATALOG.map((entry) => (entry.module === "audio" ? { ...entry, active: false } : entry)));
  assert.deepEqual(page.selected("Benchmark track"), ["Vision"]);
});

test("a catalog that fails still leaves a selected, reachable track", async (t) => {
  const page = await mount(t, "/leaderboard");
  await page.failCatalog();
  assert.deepEqual(page.selected("Benchmark track"), ["Audio"]);
  assert.deepEqual(page.reachableTabs(), ["Audio"]);
});
