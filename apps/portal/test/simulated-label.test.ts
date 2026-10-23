import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, StaticRouter } from "react-router";
import {
  BenchmarkSchema,
  DashboardSchema,
  LeaderboardSchema,
  RunSummarySchema,
  type LeaderboardEntry,
  type RunDetail,
  type RunSummary,
} from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { DashboardPage } from "../src/routes/DashboardPage.tsx";
import { PublishedGallery } from "../src/routes/LeaderboardPage.tsx";
import { RunDetailPage } from "../src/routes/RunDetailPage.tsx";
import { buildRunSummary } from "../worker/http/serializers.ts";

/**
 * The Simulated chip says a result was scripted by the fixture provider. It
 * used to read the viewer's session (the deployment's current provider), so a
 * scripted result lost its mark once the provider changed, a real result
 * gained one while it was "fixture", and the public board, which has no
 * session, never showed it. These pin it to the run's own flag.
 */

test("the flag is the run's own provider; archive results were scored for real", () => {
  const flag = (provider: string) => buildRunSummary({
    id: "run_0000000001", repositoryFullName: "demo/repo", mode: "practice", status: "succeeded",
    benchmarkId: "language-search", benchmarkVersion: 1, branch: "main", sha: "a".repeat(40),
    createdAt: 1, finishedAt: 2, attemptNumber: null,
    failureCategory: null, failurePhase: null, failureDetail: null, provider,
  } as never, null).simulated;
  assert.deepEqual(["fixture", "modal", "archive"].map(flag), [true, false, false]);
});

const CHIP = />Simulated<span class="sr-only">/;
type Provider = "fixture" | "modal";

const BENCHMARK = BenchmarkSchema.parse({
  id: "language-search", version: 1, contractVersion: "cogworks.submissions.v2",
  entryPointName: "language-search", title: "Semantic Image Search", module: "language",
  summary: "Search summary.", active: true, pluginVersion: "0.1.0", datasetVersion: "d1",
  scorerVersion: "s1", runtimeVersion: "week3-cpu-v1",
});

const PRIMARY = {
  key: "overall", label: "Overall", value: 0.44, unit: null,
  higherIsBetter: true, primary: true, precision: 3,
};

function session(provider: Provider) {
  return {
    user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "test", name: "Test" },
    team: { id: "team_1", name: "Analytical Engines", description: null, provenance: "live", repo: null },
    auth: { executionProvider: provider },
  };
}

function summary(simulated: boolean): RunSummary {
  return RunSummarySchema.parse({
    id: "run_0000000001",
    repo: { owner: "demo", name: "repo", fullName: "demo/repo", url: "https://github.com/demo/repo" },
    mode: "practice", status: "succeeded", benchmarkId: BENCHMARK.id, benchmarkVersion: 1,
    branch: "main", sha: "a".repeat(40), shortSha: "aaaaaaa",
    createdAt: 1_750_000_000_000, finishedAt: 1_750_000_060_000,
    attemptNumber: null, primaryMetric: PRIMARY, failure: null, simulated,
  });
}

function detail(simulated: boolean): RunDetail {
  return {
    ...summary(simulated),
    contractVersion: "1", parentRunId: null, surfaceId: null, sourceRefusal: null,
    promotionRefusal: null, promotedTo: null,
    phases: [], metrics: [PRIMARY], diagnostics: [], sweep: null, wiring: [], refusal: null,
    weightsSupplied: [], log: null, selected: false, publishable: false, publicationRefusal: null,
  } as RunDetail;
}

function renderRunDetail(record: RunDetail, provider: Provider): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["run", record.id], record);
  client.setQueryData(["session"], session(provider));
  client.setQueryData(["benchmarks"], [BENCHMARK]);
  const html = renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [`/runs/${record.id}`] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/runs/:runId", element: React.createElement(RunDetailPage) })))),
  );
  client.clear();
  return html;
}

function renderDashboard(run: RunSummary, provider: Provider): string {
  const d = DashboardSchema.parse({
    benchmark: BENCHMARK,
    team: {
      id: "team_1", name: "Analytical Engines", description: null, provenance: "live",
      repo: { owner: "demo", name: "repo", fullName: "demo/repo", url: "https://github.com/demo/repo", defaultBranch: "main" },
    },
    quota: { practiceUsed: 1, practiceLimit: 10, officialUsed: 0, officialLimit: 3 },
    lastResolvedSha: run.sha, activeRun: null, latestCandidate: null, selection: null,
    runs: [run],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["session"], session(provider));
  client.setQueryData(["benchmarks"], [BENCHMARK]);
  client.setQueryData(["dashboard", BENCHMARK.id], d);
  client.setQueryData(["local-reports", BENCHMARK.id], []);
  client.setQueryData(["untracked-local-reports"], []);
  client.setQueryData(["repositories"], []);
  const html = renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client },
      React.createElement(StaticRouter, { location: "/dashboard" }, React.createElement(DashboardPage))),
  );
  client.clear();
  return html;
}

test("run detail: a fixture run viewed by a non-fixture session shows the chip", () => {
  assert.match(renderRunDetail(detail(true), "modal"), CHIP);
});

test("run detail: a real run viewed by a fixture session doesn't", () => {
  const html = renderRunDetail(detail(false), "fixture");
  assert.match(html, /Practice run on main/, "the page rendered the run");
  assert.doesNotMatch(html, /Simulated/);
});

test("runs page: a fixture run viewed by a non-fixture session is marked in the lead and the history", () => {
  const html = renderDashboard(summary(true), "modal");
  assert.match(html, CHIP);
  assert.match(html, /Run #0001 · aaaaaaa · simulated/);
});

test("runs page: a real run viewed by a fixture session carries no mark", () => {
  const html = renderDashboard(summary(false), "fixture");
  assert.match(html, /Practice run on main/, "the page rendered the run");
  assert.doesNotMatch(html, /Simulated|· simulated/);
});

test("public leaderboard: a fixture row is marked for a signed-out reader, and only that row", () => {
  const entry = (teamName: string, simulated: boolean) => ({
    rank: 1, teamName, teamDescription: null, provenance: "live", repoUrl: null, sha: "", shortSha: "",
    primaryMetric: PRIMARY, supportingMetrics: [], completedAt: 1_750_000_000_000, isYou: false,
    simulated, publicSweep: null,
  });
  const board = LeaderboardSchema.parse({
    benchmark: BENCHMARK,
    entries: [entry("Scripted Team", true), entry("Measured Team", false)],
  });
  // No QueryClient session at all: the board is public.
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client },
      React.createElement(PublishedGallery, { entries: board.entries as LeaderboardEntry[] })),
  );
  const rows = html.split("<li").slice(1);
  const rowFor = (name: string) => {
    const row = rows.find((candidate) => candidate.includes(`>${name}<`));
    assert.ok(row, `no row for ${name}`);
    return row;
  };
  assert.match(rowFor("Scripted Team"), CHIP);
  assert.doesNotMatch(rowFor("Measured Team"), /Simulated/);
});
