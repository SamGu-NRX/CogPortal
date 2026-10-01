import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TeamProcessSignals } from "@cogworks/contracts/schema";
import { buildProcessSignals, findingSentences } from "../worker/services/process-signals.ts";
import type { CommitRecord } from "../worker/github/commits.ts";
import { ProcessPanel } from "../src/components/ProcessPanel.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

/**
 * The stage rail on the Team page. Stage first-touch times only count commits
 * that touched a stage file, and the history window carries no timestamp, so
 * the oldest bar is not where the commits read begin. A run that scored
 * before any stage file was edited is still inside what was read, and the
 * rail has to draw it rather than call it older than the history.
 */

const DAY = 24 * 60 * 60 * 1_000;
const SEP_19 = Date.parse("2026-09-19T12:00:00Z");

function commit(sha: string, authoredAt: number, filesChanged: string[]): CommitRecord {
  return { sha: sha.repeat(40), authorLogin: "ada", authoredAt, filesChanged, coAuthors: [] };
}

function render(truncated: boolean): string {
  const signals = buildProcessSignals({
    commitsResult: {
      ok: true,
      truncated,
      commits: [
        commit("a", SEP_19, ["README.md"]),
        commit("b", SEP_19 + 3 * DAY, ["find_peaks.py"]),
        commit("c", SEP_19 + 4 * DAY, ["spectrogram.py"]),
      ],
    },
    runs: [{ runId: "run_1", finishedAt: SEP_19 + DAY, scored: true }],
    weekLabel: "week1",
    roster: [],
  });
  // The fields the process route sends, built the way it builds them.
  const payload: TeamProcessSignals = {
    historyQuality: signals.historyQuality,
    historyWindow: signals.historyWindow,
    weekLabel: signals.weekLabel,
    stageFootprint: signals.stageFootprint,
    firstLight: signals.firstLight,
    boundaryChurn: signals.boundaryChurn,
    ownershipBreadth: signals.ownershipBreadth,
    findingSentences: findingSentences(signals),
    computedAt: SEP_19 + 5 * DAY,
  };
  assert.equal(payload.historyQuality, "usable");
  assert.equal(payload.historyWindow?.truncated, truncated);
  assert.equal(payload.firstLight.firstScoredAt, SEP_19 + DAY);
  assert.equal(payload.stageFootprint.peaks?.firstTouchAt, SEP_19 + 3 * DAY, "the README commit is not a stage touch");

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["team-process"], payload);
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client }, React.createElement(ProcessPanel, { members: [] })),
  );
}

// The rule is decorative (aria-hidden), so its placement is its only handle;
// the stage bars are placed with plain percentages, never calc().
const ruleAcrossTracks = /style="left:calc\(/;

for (const truncated of [true, false]) {
  test(`a run that scored before any stage edit is drawn on the rail (${truncated ? "windowed" : "whole"} history)`, () => {
    const html = render(truncated);
    assert.doesNotMatch(html, /before the commits read/);
    assert.match(html, ruleAcrossTracks, "the first-scored rule is placed on the tracks");
    assert.match(html, /First scored end to end/);
    // The axis opens on the run, the earliest thing it knows about.
    assert.match(html, /<span class="u-tnum">Sep 20<\/span>/);
  });
}

test("a windowed rail says older commits were not read, without dating where reading began", () => {
  const html = render(true);
  assert.match(html, /Older commits weren(&#x27;|')t read, so a stage may have started earlier\./);
  assert.doesNotMatch(html, /history starts here/);
});
