import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { LocalReportSchema, MetricSchema, type LocalReport } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { LocalReportsTable } from "../src/components/LocalReportsTable.tsx";

/**
 * A synced local report carries the benchmark's notes, and the team's list
 * used to show only the commit, the command, the score and the sync time. A
 * teammate read "d618965 run 0.1709" with no reason, while the notes naming
 * the broken embed_text sat in the API response. The list now leads each row
 * with the notes in the benchmark's order, the first three in view and the
 * rest behind a fold, and puts the score under them.
 */

// Verbatim from a real Week 3 run whose embed_text averaged over the wrong axis.
const COMPARISON =
  "On the same rewritten queries, your search scored 0.222 and a direct ranking of your embeddings scored 0.006; search runs through your own code and is scored on its first 50 results.";
const FALLBACK =
  "adapter: called embed_text once per item (batch call failed: embed_text returned an array with 1 dimensions; expected a 2-D (rows, D) matrix.)";

function report(sha: string, diagnostics: string[], over: Partial<LocalReport> = {}): LocalReport {
  return LocalReportSchema.parse({
    reportId: `local_${sha}`,
    benchmarkId: "language-search",
    benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v2",
    sdkVersion: "0.2.0",
    pluginVersion: "0.1.0",
    repositoryId: null,
    repositoryFullName: "cogworks-demo/face-finder",
    sha: sha.padEnd(40, "0"),
    dirty: false,
    startedAt: 1_759_500_000_000,
    finishedAt: 1_759_500_020_000,
    metrics: [
      { key: "overall", label: "Overall", value: 0.1708557946993632, unit: null, higherIsBetter: true, primary: true, precision: 4 },
    ],
    diagnostics,
    weightsUsed: [],
    command: "run",
    author: { login: "ada", name: "Ada Lovelace" },
    syncedAt: Date.now() - 60_000,
    trust: "local_self_reported",
    ...over,
  });
}

const FIVE = ["first note", "second note", "third note", "fourth note", "fifth note"];

function render(reports: LocalReport[]): string {
  return renderToStaticMarkup(
    React.createElement(LocalReportsTable, { reports, caption: "Self-reported local CogBench results" }),
  );
}

/** The markup of the one row that names this commit. */
function rowOf(html: string, sha: string): string {
  const rows = html.match(/<tr class="align-top">[\s\S]*?<\/tr>/g) ?? [];
  const matching = rows.filter((row) => row.includes(sha));
  assert.equal(matching.length, 1, `exactly one row names ${sha}`);
  return matching[0]!;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const decode = (html: string) => html.replace(/&(amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]!);

/** Every note in the row as rendered text, in rendering order: the sentence, then each listed note. */
function notesOf(row: string): string[] {
  const sentence = row.match(/<p class="font-serif[^"]*">([^<]*)<\/p>/)?.[1];
  const listed = [...row.matchAll(/<li [^>]*><span aria-hidden="true"[^>]*><\/span><span class="min-w-0[^"]*">([^<]*)<\/span><\/li>/g)].map(
    (match) => match[1]!,
  );
  return [...(sentence === undefined ? [] : [sentence]), ...listed].map(decode);
}

/** Markup inside the Veil's hidden region, if the row has one. */
function folded(row: string): string {
  const match = row.match(/<div aria-hidden="true" inert=""[^>]*>([\s\S]*?)<\/div>/);
  return match?.[1] ?? "";
}

test("the real two-note report shows both notes in order, with no fold, and the score after them", () => {
  const row = rowOf(render([report("d618965", [COMPARISON, FALLBACK])]), "d618965");

  assert.deepEqual(notesOf(row), [COMPARISON, FALLBACK], "both notes, verbatim, in the benchmark's order");
  assert.ok(row.indexOf("adapter: called embed_text") < row.indexOf("Overall 0.1709"), "the score comes after the notes");
  assert.equal(folded(row), "", "nothing is folded away");
  assert.doesNotMatch(row, /more note/);
});

test("one note stands alone as the sentence", () => {
  const row = rowOf(render([report("06460ef", [COMPARISON])]), "06460ef");

  assert.match(row, /<p class="font-serif[^"]*">On the same rewritten queries/);
  assert.doesNotMatch(row, /<ul/);
  assert.match(row, /Overall 0\.1709/);
});

test("a report with no notes says so and claims nothing else", () => {
  const row = rowOf(render([report("3b0c9e2", [])]), "3b0c9e2");

  assert.match(row, />This report has no notes\.<\/p>/);
  assert.match(row, /Overall 0\.1709/);
  assert.doesNotMatch(row, /font-serif/);
  assert.doesNotMatch(row, /\b(pass|passed|clean|no issues|all good|healthy|success)\b/i);
});

test("past three notes, exactly the rest fold away, in order, behind a counted control", () => {
  const row = rowOf(render([report("c29e5b1", FIVE)]), "c29e5b1");
  const hidden = folded(row);
  const visible = row.replace(hidden, "");

  assert.deepEqual(notesOf(visible), FIVE.slice(0, 3), "the first three in view, in order");
  assert.deepEqual(notesOf(hidden), FIVE.slice(3), "exactly the rest folded, in order");
  assert.deepEqual(notesOf(row), FIVE, "nothing reordered across the fold");
  assert.match(row, /aria-expanded="false"[^>]*>[\s\S]*?See 2 more notes/);
});

test("one folded note is counted in the singular", () => {
  const row = rowOf(render([report("c29e5b2", FIVE.slice(0, 4))]), "c29e5b2");
  assert.match(row, /See 1 more note</);
});

test("a note shaped like HTML shows as text", () => {
  const note = "search returned <img src=x onerror=alert(1)> where ids were expected";
  const row = rowOf(render([report("c29e5b3", [note])]), "c29e5b3");

  assert.ok(row.includes("&lt;img src=x onerror=alert(1)&gt;"), "escaped");
  assert.doesNotMatch(row, /<img/);
  assert.deepEqual(notesOf(row), [note], "shown verbatim");
});

test("a long unbroken note may wrap anywhere instead of widening the row", () => {
  const long = "could not load weights from models/" + "encoder_checkpoint_".repeat(8) + "final.npz";
  const row = rowOf(render([report("c29e5b4", ["first", long])]), "c29e5b4");

  assert.match(row, /\[overflow-wrap:anywhere\]">could not load weights/);
  assert.match(row, /<p class="font-serif[^"]*\[overflow-wrap:anywhere\][^"]*">first</);
});

test("the row keeps its identity: commit, dirty marker, command and sync time, and no author", () => {
  const html = render([report("bbbbbbb", [COMPARISON], { dirty: true, command: "test" })]);
  const row = rowOf(html, "bbbbbbb");

  assert.match(row, /bbbbbbb <span class="whitespace-nowrap">· dirty<\/span>/);
  assert.match(row, /text-ink-secondary">cogworks test<\/p>/);
  assert.match(row, /Overall 0\.1709<\/span>\u00a0· <span class="whitespace-nowrap">synced [^<]+ ago<\/span>/);
  // A smoke test's score sits one step lighter than a run's.
  assert.match(row, /<span class="\[overflow-wrap:anywhere\] text-ink-faint">Overall 0\.1709<\/span>/);
  assert.ok(!row.includes("ada") && !row.includes("Ada Lovelace"), "no author");
  assert.match(html, /A <code[^>]*>test<\/code> row scored only the small/);
});

test("a report from before the CLI recorded the command says so", () => {
  const row = rowOf(render([report("ccccccc", [], { command: undefined })]), "ccccccc");
  assert.match(row, /text-ink-faint">command not recorded<\/p>/);
});

test("a long metric label and unit may wrap instead of widening the row", () => {
  // The schema bounds neither string, so a self-reported metric can carry
  // a long unbroken token; this one parses as it is.
  const label = "Mean_reciprocal_rank_over_every_rewritten_query_and_typo_variant";
  const unit = "ranks_per_thousand_locally_measured_queries";
  const metric = MetricSchema.parse({ key: "overall", label, value: 0.17, unit, higherIsBetter: true, primary: true, precision: 2 });
  const row = rowOf(render([report("c29e5b5", ["first"], { metrics: [metric] })]), "c29e5b5");

  assert.ok(
    row.includes(`<span class="[overflow-wrap:anywhere] text-ink-secondary">${label} 0.17 ${unit}</span>`),
    "label, value and unit sit in a span that may wrap anywhere",
  );
});

/** Each notes control's accessible name: its visible label plus its screen-reader-only context. */
function controlNames(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-expanded="[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    decode(match[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
  );
}

test("each row's notes control names its own report, while the visible label stays short", () => {
  const html = render([
    report("c29e5b1", FIVE),
    report("4c1f0e2", FIVE.slice(0, 4), { dirty: true, command: "test" }),
  ]);

  assert.deepEqual(controlNames(html), [
    "See 2 more notes for commit c29e5b1 (cogworks run, synced 1 min ago)",
    "See 1 more note for commit 4c1f0e2 (dirty, cogworks test, synced 1 min ago)",
  ]);
  // The context is for assistive technology; the visible label is unchanged.
  assert.match(html, />See 2 more notes<span class="sr-only"> for commit c29e5b1 /);
});

test("rows that would read alike are told apart by the end of their report id", () => {
  // The same commit synced twice in the same minute with the same command.
  const twin = (reportId: string) => report("c29e5b1", FIVE.slice(0, 4), { reportId });
  const names = controlNames(render([twin("local_0000000000aaaaaa111111"), twin("local_0000000000aaaaaa222222")]));

  assert.equal(new Set(names).size, 2, "two distinct names");
  assert.match(names[0]!, /^See 1 more note for commit c29e5b1 \(cogworks run, synced 1 min ago, report 111111\)$/);
  assert.match(names[1]!, /^See 1 more note for commit c29e5b1 \(cogworks run, synced 1 min ago, report 222222\)$/);
});

test("in the table for benchmarks without a track, the name leads with the benchmark", () => {
  const html = renderToStaticMarkup(
    React.createElement(LocalReportsTable, {
      reports: [report("c29e5b1", FIVE)],
      caption: "Untracked",
      catalog: [],
    }),
  );
  assert.deepEqual(controlNames(html), [
    "See 2 more notes for language-search v1, commit c29e5b1 (cogworks run, synced 1 min ago)",
  ]);
});

/* ── The fold, operated ──────────────────────────────────────────────────── */

async function mount(t: TestContext, reports: LocalReport[]) {
  const window = new Window({ url: "https://portal.example/dashboard" });
  class NoResizeObserver {
    observe() {}
    disconnect() {}
  }
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    ResizeObserver: NoResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () =>
    root.render(React.createElement(LocalReportsTable, { reports, caption: "Self-reported local CogBench results" })),
  );
  return container;
}

test("the fold opens, closes and opens again from its control, and only open notes are exposed", async (t) => {
  const container = await mount(t, [report("c29e5b1", FIVE)]);
  const toggle = container.querySelector("button[aria-expanded]");
  assert.ok(toggle, "the row has a fold control");
  const region = container.ownerDocument.getElementById(toggle.getAttribute("aria-controls") ?? "");
  assert.ok(region, "the control names its region");
  const notes = () => region.querySelector("[aria-hidden]");

  const expectState = (open: boolean) => {
    assert.equal(toggle.getAttribute("aria-expanded"), String(open));
    assert.equal(notes()?.getAttribute("aria-hidden"), String(!open));
    assert.equal(notes()?.hasAttribute("inert"), !open);
    assert.match(toggle.textContent ?? "", open ? /Show fewer notes/ : /See 2 more notes/);
  };

  expectState(false);
  for (const open of [true, false, true]) {
    await act(async () => (toggle as unknown as HTMLButtonElement).click());
    expectState(open);
  }
  assert.ok(notes()?.textContent?.includes("fifth note"));
});

test("open or closed, two rows' notes controls keep names of their own", async (t) => {
  const container = await mount(t, [report("c29e5b1", FIVE), report("4c1f0e2", FIVE)]);
  const toggles = Array.from(container.querySelectorAll("button[aria-expanded]"));
  assert.equal(toggles.length, 2);
  const names = () => toggles.map((toggle) => (toggle.textContent ?? "").replace(/\s+/g, " ").trim());

  assert.deepEqual(names(), [
    "See 2 more notes for commit c29e5b1 (cogworks run, synced 1 min ago)",
    "See 2 more notes for commit 4c1f0e2 (cogworks run, synced 1 min ago)",
  ]);
  for (const toggle of toggles) await act(async () => (toggle as unknown as HTMLButtonElement).click());
  assert.deepEqual(names(), [
    "Show fewer notes for commit c29e5b1 (cogworks run, synced 1 min ago)",
    "Show fewer notes for commit 4c1f0e2 (cogworks run, synced 1 min ago)",
  ]);
});

test("focusing the fold doesn't make a table that fits a tab stop of its own", async (t) => {
  const container = await mount(t, [report("c29e5b1", FIVE)]);
  const toggle = container.querySelector("button[aria-expanded]") as unknown as HTMLButtonElement;
  const scroller = container.querySelector("table")?.parentElement;
  assert.ok(scroller, "the table sits in its scroll box");
  await act(async () => toggle.focus());
  assert.equal(container.ownerDocument.activeElement, toggle as unknown);
  assert.equal(scroller.hasAttribute("tabindex"), false, "no tab stop on a box that doesn't overflow");
  assert.equal(scroller.getAttribute("role"), null);
});
