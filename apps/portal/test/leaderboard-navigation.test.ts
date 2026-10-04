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
async function mount(
  t: TestContext,
  path: string,
  answerOverall: boolean | object = false,
  boards: Record<string, object> = {},
) {
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
    if (answerOverall && input.startsWith("/api/leaderboard-family")) {
      return Response.json(answerOverall === true ? EMPTY_OVERALL : answerOverall);
    }
    const board = /^\/api\/leaderboard\?benchmark=(.+)$/.exec(input)?.[1];
    if (board && boards[board]) {
      return Response.json(boards[board], { status: "error" in boards[board] ? 500 : 200 });
    }
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

/* ── What a published board says about its results ─────────────────────── */

function boardMetric(key: string, label: string, value: number, role: string | null, primary = false) {
  return { key, label, value, unit: null, higherIsBetter: true, primary, precision: 3, help: null, role, relatesTo: null };
}

function boardEntry(teamName: string, completedAt: number, overall: number, extra: Record<string, unknown> = {}) {
  return {
    rank: 0, teamName, teamDescription: null, provenance: "live", repoUrl: null,
    sha: "a".repeat(40), shortSha: "aaaaaaa",
    primaryMetric: boardMetric("overall", "Overall", overall, "scored", true),
    supportingMetrics: [], completedAt, isYou: false, ...extra,
  };
}

/** Wire order is the read model's: best score first, with its ranks. */
const LANGUAGE_BOARD = {
  benchmark: {
    ...CATALOG[3]!, scorerVersion: "retrieval-v4",
    summary: "Caption-to-image retrieval with your trained encoder in the caption-embedding space.",
  },
  entries: [
    boardEntry("Lantern Lab", 1_790_900_412_000, 0.512, {
      rank: 1,
      teamDescription: "Caption embeddings averaged over GloVe.",
      supportingMetrics: [
        boardMetric("chance_mrr", "Chance MRR", 0.013, "floor"),
        boardMetric("text_mrr", "Text MRR", 0.881, "scored"),
        boardMetric("search_mrr_verbatim", "Search MRR, caption unchanged (not scored)", 0.641, "reported"),
        boardMetric("median_rank", "Median rank", 4, "diagnostic"),
        boardMetric("search_mrr_typo", "Search MRR, one typo", 0.51, "plotted"),
      ],
    }),
    boardEntry("Team Heron", 1_786_000_500_000, 0.48, { rank: 2, provenance: "archive", sha: "", shortSha: "" }),
    boardEntry("Tidepool", 1_791_000_470_000, 0.447, {
      rank: 3,
      supportingMetrics: [boardMetric("text_mrr", "Text MRR", 0.802, null)],
    }),
  ],
};

async function openLanguage(t: TestContext) {
  const page = await mount(t, "/leaderboard?benchmark=language-search", false, { "language-search": LANGUAGE_BOARD });
  await page.answerCatalog();
  await settle(() => page.container.querySelectorAll("ol li").length === 3, "the Language board");
  return page;
}

const teamOrder = (container: Container) =>
  [...container.querySelectorAll("ol li h3")].map((node) => node.textContent);

test("a board reads newest first, not in the read model's score order", async (t) => {
  const page = await openLanguage(t);
  assert.deepEqual(teamOrder(page.container), ["Tidepool", "Lantern Lab", "Team Heron"]);
  assert.equal(page.container.querySelector("ol")?.getAttribute("aria-label"), "Published results, newest first");
  // No rank survives into the page in any form.
  assert.doesNotMatch(page.container.querySelector("ol")?.textContent ?? "", /#\d|\brank\b/i);
});

test("a board names what it measures and exactly which results it compares", async (t) => {
  const page = await openLanguage(t);
  assert.equal(page.container.querySelector("h1")?.textContent, "Semantic Search");
  assert.match(page.container.textContent ?? "", /Caption-to-image retrieval with your trained encoder/);
  assert.equal(
    page.container.querySelector("[data-board-scope]")?.textContent,
    "language-search v1 · scorer retrieval-v4 · newest first",
  );
});

test("a team's line is labelled as about the team and comes after its result", async (t) => {
  const page = await openLanguage(t);
  const row = [...page.container.querySelectorAll("ol li")].find((node) => node.querySelector("h3")?.textContent === "Lantern Lab");
  assert.ok(row);
  const line = row.querySelector("[data-team-description]");
  assert.equal(line?.textContent, "About the teamCaption embeddings averaged over GloVe.");
  const details = [...row.querySelectorAll("button")].find((button) => /Details/.test(button.textContent ?? ""));
  assert.ok(details && line);
  // Node.DOCUMENT_POSITION_FOLLOWING: the line follows the reading and its Details control.
  assert.ok(details.compareDocumentPosition(line as never) & 4, "the team's line follows the result");
  // A team without a line shows no empty label.
  const tidepool = [...page.container.querySelectorAll("ol li")].find((node) => node.querySelector("h3")?.textContent === "Tidepool");
  assert.equal(tidepool?.querySelector("[data-team-description]"), null);
});

test("details group a result's measurements by the role the benchmark gave them", async (t) => {
  const page = await openLanguage(t);
  const open = async (team: string) => {
    const row = [...page.container.querySelectorAll("ol li")].find((node) => node.querySelector("h3")?.textContent === team)!;
    const button = [...row.querySelectorAll("button")].find((node) => /Details/.test(node.textContent ?? ""))!;
    await act(async () => (button as unknown as HTMLElement).click());
    return [...row.querySelectorAll("[data-metric-group]")].map((group) => [
      group.querySelector("h4")?.textContent,
      [...group.querySelectorAll("dt")].map((node) => node.textContent),
    ]);
  };
  assert.deepEqual(await open("Lantern Lab"), [
    ["Part of the score", ["Text MRR"]],
    ["Measured, not scored", ["Search MRR, caption unchanged (not scored)"]],
    ["Plotted values", ["Search MRR, one typo"]],
    ["Floors set by the data", ["Chance MRR"]],
    ["Diagnostics", ["Median rank"]],
    ["This result", ["Commit", "Completed", "Repository"]],
  ]);
  // A run that recorded no roles is not passed off as scored.
  assert.deepEqual(await open("Tidepool"), [
    ["Role not recorded", ["Text MRR"]],
    ["This result", ["Commit", "Completed", "Repository"]],
  ]);
  // An archive row keeps withholding its commit and repository.
  assert.deepEqual(await open("Team Heron"), [["This result", ["Completed"]]]);
});

test("Overall is titled and scoped by its own family, from its components", async (t) => {
  const overall = {
    family: {
      id: "vision-overall", version: 1, title: "Vision Overall", module: "vision", active: true,
      components: [
        { key: "known", label: "Known identification", benchmarkId: "vision-recognition", benchmarkVersion: 2, metricKey: "known", weight: 1 / 3 },
        { key: "lifecycle", label: "Unknown lifecycle", benchmarkId: "vision-recognition", benchmarkVersion: 2, metricKey: "lifecycle", weight: 1 / 3 },
        { key: "f1", label: "Clustering pairwise F1", benchmarkId: "vision-clustering", benchmarkVersion: 2, metricKey: "f1", weight: 1 / 3 },
      ],
    },
    entries: [boardEntry("Lantern Lab", 1_790_950_901_000, 0.721)],
  };
  const page = await mount(t, "/leaderboard", overall);
  await page.answerCatalog(CATALOG.map((entry) => (entry.module === "audio" ? { ...entry, active: false } : entry)));
  await settle(() => page.container.querySelectorAll("ol li").length === 1, "the Overall board");
  assert.equal(page.container.querySelector("h1")?.textContent, "Vision Overall");
  assert.equal(
    page.container.querySelector("[data-board-scope]")?.textContent,
    "vision-overall v1 · from vision-recognition v2 + vision-clustering v2 · newest first",
  );
  assert.match(
    page.container.textContent ?? "",
    /Vision Overall weights Known identification, Unknown lifecycle and Clustering pairwise F1 equally\. All three components must come from selected official runs at the same repository and commit\./,
  );
});

test("an empty board keeps its empty state and states no scope for rows it does not have", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=language-search", false, {
    "language-search": { ...LANGUAGE_BOARD, entries: [] },
  });
  await page.answerCatalog();
  await settle(() => /No results published yet\./.test(page.container.textContent ?? ""), "the empty board");
  assert.equal(page.container.querySelector("[data-board-scope]"), null);
  assert.equal(page.container.querySelector("ol"), null);
});

const CURVE_TICKS = [
  { x: 0, label: "verbatim" },
  { x: 1, label: "keywords" },
  { x: 2, label: "truncated" },
  { x: 3, label: "typo" },
];
const CURVED_BOARD = {
  ...LANGUAGE_BOARD,
  entries: LANGUAGE_BOARD.entries.map((entry) =>
    entry.teamName === "Lantern Lab"
      ? {
          ...entry,
          // Published as a metric, absent from the curve: the case a curve gap
          // must not hide.
          supportingMetrics: [
            ...entry.supportingMetrics,
            boardMetric("search_mrr_truncated", "Search MRR, first three words", 0.402, "plotted"),
          ],
          publicSweep: {
            axis: "query variant", metric: "Search MRR", ticks: CURVE_TICKS,
            points: [{ x: 0, y: 0.6412 }, { x: 1, y: 0.5733 }, { x: 3, y: 0.5104 }],
          },
        }
      : entry,
  ),
};

test("a published curve leads its entry, before the score, with every reading in Details", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=language-search", false, { "language-search": CURVED_BOARD });
  await page.answerCatalog();
  await settle(() => page.container.querySelectorAll("ol li").length === 3, "the curved board");
  const row = (team: string) =>
    [...page.container.querySelectorAll("ol li")].find((node) => node.querySelector("h3")?.textContent === team)!;

  const lantern = row("Lantern Lab");
  const reading = lantern.querySelector("[data-public-curve] p");
  assert.equal(
    reading?.textContent,
    "Search MRR by query variant: lowest 0.51 (typo), highest 0.64 (verbatim). No curve point for truncated.",
  );
  const score = [...lantern.querySelectorAll("span")].find((node) => node.textContent?.startsWith("Overall"));
  assert.ok(score && reading && reading.compareDocumentPosition(score as never) & 4, "the reading comes before the score");
  // Categorical variants: points, no joining line.
  assert.equal(lantern.querySelectorAll("[data-public-curve] svg circle").length, 3);
  assert.equal(lantern.querySelectorAll("[data-public-curve] svg path").length, 0);

  const details = [...lantern.querySelectorAll("button")].find((node) => /Details/.test(node.textContent ?? ""))!;
  await act(async () => (details as unknown as HTMLElement).click());
  const curveTable = lantern.querySelector('[data-metric-group="curve"]');
  assert.equal(curveTable?.querySelector("h4")?.textContent, "Search MRR by query variant");
  assert.deepEqual(
    [...(curveTable?.querySelectorAll("dl > div") ?? [])].map((node) => [node.querySelector("dt")?.textContent, node.querySelector("dd")?.textContent]),
    [["verbatim", "0.641"], ["keywords", "0.573"], ["truncated", "no curve point"], ["typo", "0.510"]],
  );
  // A published plotted measurement stays listed beside the curve; a gap in
  // the curve must never hide a number the run published.
  assert.deepEqual(
    [...(lantern.querySelector('[data-metric-group="plotted"]')?.querySelectorAll("dt") ?? [])].map((node) => node.textContent),
    ["Search MRR, one typo", "Search MRR, first three words"],
  );

  // Neighbours without a curve say so plainly, and accuse nobody.
  assert.equal(row("Tidepool").querySelector('[data-public-curve="none"]')?.textContent, "No curve shown for this run.");
  assert.match(page.container.textContent ?? "", /Each curve is drawn on the same scale/);
});

test("a board with no curves at all shows no curve placeholders", async (t) => {
  const page = await openLanguage(t);
  assert.equal(page.container.querySelector("[data-public-curve]"), null);
  assert.doesNotMatch(page.container.textContent ?? "", /No curve shown|same scale/);
});

test("a board that fails to load says so and offers a retry, not an empty board", async (t) => {
  const page = await mount(t, "/leaderboard?benchmark=language-search", false, {
    "language-search": { error: { code: "internal", message: "The board could not be read." } },
  });
  await page.answerCatalog();
  await settle(() => /Try again|Retry/i.test(page.container.textContent ?? ""), "the board error");
  assert.doesNotMatch(page.container.textContent ?? "", /No results published yet/);
});
