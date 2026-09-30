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
    promotionRefusal: null,
    retryRefusal: null,
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

/**
 * What the console says when a control is missing.
 *
 * Both sentences come from the server and are rendered only where their button
 * would have been. The console writes no refusal of its own: it has no view of
 * quota, sign-in or provider availability, and a second opinion about
 * eligibility is how a client ends up offering what the server refuses.
 */

function failedHosted(over: Partial<RunSurfaceSnapshot> = {}): RunSurfaceSnapshot {
  return {
    ...snapshot("failed"),
    stage: "hosted",
    localRunId: null,
    practiceRunId: "run_hosted_123",
    refusalHeadline: "The benchmark could not score this run.",
    events: [],
    ...over,
  };
}

const CHANGED_INPUTS = "Repository or benchmark/runtime configuration changed since this run.";

test("a failed run with no Retry says why, in the place Retry would have been", () => {
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: failedHosted({ retryRefusal: CHANGED_INPUTS }),
    streamState: "closed",
    onAction: () => undefined,
  }));
  assert.match(html, /Repository or benchmark\/runtime configuration changed since this run\./);
  // The historical failure is a different sentence and both belong.
  assert.match(html, /The benchmark could not score this run\./);
  assert.doesNotMatch(html, />Retry</);
});

test("the same sentence survives Discord's tile, where there is no sidebar", () => {
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: failedHosted({ retryRefusal: CHANGED_INPUTS }),
    streamState: "closed",
    compact: true,
    onAction: () => undefined,
  }));
  assert.doesNotMatch(html, /Run reference/);
  assert.match(html, /Repository or benchmark\/runtime configuration changed since this run\./);
});

test("an offered Retry carries no refusal beside it", () => {
  // The server sends the sentence and the action together only when they
  // disagree, but the console must not print both even then.
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: failedHosted({ retryRefusal: CHANGED_INPUTS, actions: ["open_console", "open_portal", "retry"] }),
    streamState: "closed",
    onAction: () => undefined,
  }));
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, /configuration changed since this run/);
});

test("no retry refusal means no sentence, not a promise that Retry would work", () => {
  // Quota, sign-in and provider availability all withhold Retry without
  // sending a refusal, so silence here is the only honest rendering.
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: failedHosted(),
    streamState: "closed",
    onAction: () => undefined,
  }));
  assert.doesNotMatch(html, />Retry</);
  assert.doesNotMatch(html, /you can retry|try again|available/i);
});

test("a succeeded run that cannot be promoted says so where Promote was", () => {
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: failedHosted({
      status: "succeeded",
      phase: "complete",
      refusalHeadline: null,
      promotionRefusal: "The saved environment is not compatible with this benchmark's current execution contract.",
      actions: ["open_console", "open_portal", "rerun_hosted"],
    }),
    streamState: "closed",
    onAction: () => undefined,
  }));
  assert.match(html, /Run reference/);
  assert.match(html, /The saved environment is not compatible with this benchmark/);
  assert.doesNotMatch(html, /Promote to official/);
});

test("a run from another repository gets one sentence, not two", () => {
  // Both refusals are true at once for a replaced repository, and the source
  // one is what the server answers first, so it is the one that applies.
  const html = renderToStaticMarkup(React.createElement(RunConsole, {
    snapshot: failedHosted({
      status: "succeeded",
      phase: "complete",
      refusalHeadline: null,
      sourceRefusal: "This run came from a repository your team is no longer connected to.",
      promotionRefusal: "The saved environment can't be matched to the connected repository.",
      actions: ["open_console", "open_portal"],
    }),
    streamState: "closed",
    onAction: () => undefined,
  }));
  assert.match(html, /no longer connected to/);
  assert.doesNotMatch(html, /matched to the connected repository/);
});
