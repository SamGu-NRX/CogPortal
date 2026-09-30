import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSurfaceSnapshot } from "@cogworks/contracts/schema";

import { RunConsole } from "../src/components/RunConsole";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function snapshot(status: RunSurfaceSnapshot["status"]): RunSurfaceSnapshot {
  const started = 1_750_000_000_000;
  return {
    id: `surface_${"a".repeat(20)}`,
    team: { id: "team-1", name: "Analytical Engines" },
    benchmark: { id: "vision-recognition", version: 1, title: "Vision Recognition" },
    actor: { login: "ada", name: "Ada" },
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    branch: "main",
    dirty: false,
    stage: "local",
    status,
    phase: status === "running" ? "evaluating" : status,
    createdAt: started,
    updatedAt: started + 8_000,
    finishedAt: status === "running" ? null : started + 8_000,
    elapsedMs: 8_000,
    progress: { current: 18, total: 40, unit: "cases" },
    primaryMetric: status === "succeeded" ? {
      key: "accuracy",
      label: "Accuracy",
      value: 0.913,
      unit: null,
      higherIsBetter: true,
      primary: true,
      precision: 3,
    } : null,
    metrics: [],
    teamBest: null,
    refusalHeadline: null,
    source: null,
    sourceRefusal: null,
    localRunId: "localrun_123",
    practiceRunId: null,
    officialRunId: null,
    executionHistory: [],
    executionGeneration: 0,
    snapshotRevision: 1,
    published: false,
    nextOfficialAttempt: 2,
    events: [0, 1, 2, 3, 4].map((sequence) => ({
      eventId: `stream_event_${sequence}`,
      source: "local" as const,
      sourceRunId: "localrun_123",
      sourceSequence: sequence,
      phase: "evaluating",
      code: sequence ? "evaluation.progress" as const : "repository.ready" as const,
      occurredAt: started + sequence * 2_000,
      elapsedMs: sequence * 2_000,
      progress: sequence ? { current: sequence, total: 40, unit: "cases" as const } : null,
    })),
    actions: ["open_console", "open_portal"],
    simulated: true,
  };
}

test("running console exposes live progress without rendering unsafe raw output", () => {
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: snapshot("running"),
    streamState: "live",
  }));
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="18"/);
  assert.match(html, /18\/40 cases/);
  assert.match(html, />Live</);
  assert.doesNotMatch(html, /stdout|environment|prediction/i);
});

test("terminal console says complete and collapses its history", () => {
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: snapshot("succeeded"),
    streamState: "live",
  }));
  assert.match(html, />Complete</);
  assert.doesNotMatch(html, />Live</);
  assert.match(html, /Show all 5/);
  assert.equal((html.match(/class="run-event/g) ?? []).length, 3);
  assert.doesNotMatch(html, /role="progressbar"/);
});

test("compact Activity layout keeps lifecycle context but omits the detail surface", () => {
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: snapshot("running"),
    streamState: "live",
    compact: true,
  }));
  assert.match(html, /data-compact="true"/);
  assert.match(html, /Run lifecycle/);
  assert.doesNotMatch(html, /Safe event stream/);
  assert.doesNotMatch(html, /Run reference/);
});

test("hosted stage never presents the completed local event tail as current work", () => {
  const hosted = snapshot("running");
  hosted.stage = "hosted";
  hosted.phase = "preparing";
  hosted.progress = null;
  hosted.practiceRunId = "run_hosted_123";
  hosted.events = [
    ...hosted.events,
    {
      eventId: "local_complete_123",
      source: "local",
      sourceRunId: "localrun_123",
      sourceSequence: 5,
      phase: "scoring",
      code: "run.completed",
      occurredAt: hosted.updatedAt + 1,
      elapsedMs: 9_000,
      progress: null,
    },
    {
      eventId: "hosted_fetch_123",
      source: "practice",
      sourceRunId: "run_hosted_123",
      sourceSequence: 0,
      phase: "preparing",
      code: "repository.fetching",
      occurredAt: hosted.updatedAt + 2,
      elapsedMs: 0,
      progress: null,
    },
  ];
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: hosted,
    streamState: "live",
  }));
  assert.match(html, /Fetching repository/);
  assert.doesNotMatch(html, /Run complete/);
});

test("every lifecycle stage is named at every width, and the tile ignores the window", () => {
  // Two failures at one site. A 768px window around a 352px tile satisfied
  // `sm:`, turning the inline labels on inside it; the section is
  // overflow-hidden, so they were clipped, measured at 352px client against
  // 362px scroll. Hiding them instead left four unlabelled statuses. Stacking
  // the name under the mark is what fits, so nothing has to be dropped.
  const lifecycle = (compact: boolean) => {
    const html = renderToStaticMarkup(React.createElement(RunConsole, {
      snapshot: snapshot("running"),
      streamState: "live",
      compact,
    }));
    const start = html.indexOf('aria-label="Run lifecycle"');
    assert.notEqual(start, -1, "the lifecycle row is always rendered");
    return html.slice(start, html.indexOf("</ol>", start));
  };

  const tile = lifecycle(true);
  assert.doesNotMatch(tile, /sm:|min-\[420px\]/, "no viewport breakpoint decides a tile's layout");

  // Every stage is named, drawn and not merely announced. The mark beside it
  // is aria-hidden, so a hidden name leaves four unlabelled statuses.
  for (const label of ["Local", "Hosted", "Official", "Published"]) {
    assert.match(tile, new RegExp(`>${label}<`), label);
  }
  assert.doesNotMatch(tile, /class="(hidden|sr-only)[^"]*">(Local|Hosted|Official|Published)</);
  assert.match(tile, /class="sr-only">active</, "the state stays on its own span");
  // Stacked, because a quarter of a tile does not fit a mark and a word in a
  // row. This is the class that keeps them from being clipped.
  assert.match(tile, /flex flex-col/);

  // The full console fills the window, so the window is the right thing for it
  // to measure. It stacks the same way when narrow and takes the inline row at
  // `sm:`, which is the first width where a quarter of it fits mark and name
  // side by side.
  const full = lifecycle(false);
  assert.match(full, /flex flex-col/);
  assert.match(full, /sm:flex-row sm:justify-start sm:gap-2 sm:px-4 sm:py-0/);
  for (const label of ["Local", "Hosted", "Official", "Published"]) {
    assert.match(full, new RegExp(`>${label}<`), label);
  }
  assert.doesNotMatch(full, /class="(hidden|sr-only)[^"]*">(Local|Hosted|Official|Published)</);
});
