import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BenchmarkSchema,
  DashboardSchema,
  LocalReportSchema,
  type Benchmark,
  type LocalReport,
} from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { DashboardPage } from "../src/routes/DashboardPage.tsx";

/**
 * `cogworks sync` accepts a report for any benchmark, but each track's table
 * only lists its benchmark's active version. A report for an inactive
 * benchmark (audio-identification v1 is inactive on purpose, migration 0020)
 * or a superseded version was stored and then shown on no page. The dashboard
 * now reads the server's untracked list as well and gives those reports their
 * own group, without the author's name beside the number.
 */

function benchmark(id: string, version: number, title: string, active: boolean): Benchmark {
  return BenchmarkSchema.parse({
    id,
    version,
    contractVersion: "cogworks.submissions.v2",
    entryPointName: id,
    title,
    module: id.startsWith("audio") ? "audio" : "vision",
    summary: "Test benchmark",
    active,
    pluginVersion: "0.1.0",
    datasetVersion: "d1",
    scorerVersion: "s1",
    runtimeVersion: "python3.8",
  });
}

const CURRENT = benchmark("vision-recognition", 2, "Face Recognition", true);
const CATALOG = [
  CURRENT,
  benchmark("vision-recognition", 1, "Face Recognition", false),
  benchmark("audio-identification", 1, "Song Identification", false),
];

function report(
  reportId: string,
  benchmarkId: string,
  benchmarkVersion: number,
  shaChar: string,
  value: number,
  login: string,
): LocalReport {
  return LocalReportSchema.parse({
    reportId,
    benchmarkId,
    benchmarkVersion,
    contractVersion: "cogworks.submissions.v2",
    sdkVersion: "0.2.0",
    pluginVersion: "0.1.0",
    repositoryId: 1,
    repositoryFullName: "demo-org/team-repo",
    sha: shaChar.repeat(40),
    dirty: shaChar === "b",
    startedAt: 1_750_000_000_000,
    finishedAt: 1_750_000_001_000,
    metrics: [
      {
        key: "accuracy",
        label: "Accuracy",
        value,
        unit: null,
        higherIsBetter: true,
        primary: true,
        precision: 3,
      },
    ],
    diagnostics: [],
    weightsUsed: [],
    author: { login, name: `${login} full name` },
    syncedAt: Date.now() - 60_000,
    trust: "local_self_reported",
  });
}

// On the selected track, so only the scoped list holds it.
const ON_TRACK = report("report_on_track", "vision-recognition", 2, "a", 0.875, "ada-on-track");
// Inactive benchmark: only the untracked list holds it.
const INACTIVE = report("report_inactive", "audio-identification", 1, "b", 0.512, "grace-inactive");
// Superseded version of the active benchmark: also only in the untracked list.
const SUPERSEDED = report("report_superseded", "vision-recognition", 1, "c", 0.64, "alan-superseded");

const DASHBOARD = DashboardSchema.parse({
  benchmark: CURRENT,
  team: {
    id: "team_1",
    name: "Analytical Engines",
    description: null,
    provenance: "live",
    repo: {
      owner: "demo-org",
      name: "team-repo",
      fullName: "demo-org/team-repo",
      url: "https://github.com/demo-org/team-repo",
      defaultBranch: "main",
    },
  },
  quota: { practiceUsed: 0, practiceLimit: 10, officialUsed: 0, officialLimit: 3 },
  lastResolvedSha: null,
  activeRun: null,
  latestCandidate: null,
  selection: null,
  runs: [],
});

function render(seed: {
  scoped: LocalReport[];
  untracked?: LocalReport[];
  untrackedError?: boolean;
}): string {
  // retryOnMount off: otherwise a mounted query in the error state with no
  // data reports itself pending (it would refetch), and SSR never settles it.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  client.setQueryData(["benchmarks"], CATALOG);
  client.setQueryData(["dashboard", CURRENT.id], DASHBOARD);
  client.setQueryData(["repositories"], []);
  client.setQueryData(["local-reports", CURRENT.id], seed.scoped);
  if (seed.untracked) client.setQueryData(["untracked-local-reports"], seed.untracked);
  if (seed.untrackedError) {
    client
      .getQueryCache()
      .build(client, { queryKey: ["untracked-local-reports"] })
      .setState({ status: "error", error: new Error("boom"), fetchStatus: "idle" });
  }
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(StaticRouter, { location: "/dashboard" }, React.createElement(DashboardPage)),
    ),
  );
}

/** The markup of the untracked group alone, so assertions about it cannot be
 *  satisfied by the track table beside it. */
function untrackedGroup(html: string): string {
  const match = html.match(/<section aria-labelledby="untracked-reports-heading"[\s\S]*?<\/section>/);
  assert.ok(match, "the untracked group renders");
  return match[0];
}

test("reports no track shows get their own group, labelled by benchmark and without an author", () => {
  const html = render({ scoped: [ON_TRACK], untracked: [INACTIVE, SUPERSEDED] });
  const group = untrackedGroup(html);

  // Title and version come from the catalog row, result from the primary metric.
  assert.match(group, /Song Identification <span[^>]*>v1<\/span>/);
  assert.match(group, /0\.512/);
  assert.match(group, /bbbbbbb <span class="whitespace-nowrap">· dirty<\/span>/);
  assert.match(group, /Face Recognition <span[^>]*>v1<\/span>/);
  assert.match(group, /0\.640/);
  assert.match(group, /Reports from benchmarks or versions that are not open for hosted runs\./);

  // No author in any form: not the login, not the display name.
  for (const author of [INACTIVE.author, SUPERSEDED.author, ON_TRACK.author]) {
    assert.ok(!group.includes(author.login), `${author.login} is absent from the group`);
    assert.ok(!group.includes(author.name!), `${author.name} is absent from the group`);
  }
  assert.doesNotMatch(group, /Student/);

  // The on-track report stays in the existing table and only there.
  assert.ok(!group.includes("aaaaaaa"));
  assert.equal(html.split("aaaaaaa").length - 1, 1);
  assert.match(html, /Self-reported local CogBench results<\/caption>[\s\S]*aaaaaaa[\s\S]*untracked-reports-heading/);
  // A rule separates the group from the table above it.
  assert.match(html, /<section aria-labelledby="untracked-reports-heading" class="mt-6 border-t/);
});

test("the panel appears for untracked reports alone, with no empty track table", () => {
  const html = render({ scoped: [], untracked: [INACTIVE] });

  assert.match(html, /id="local-reports-heading"/);
  assert.match(untrackedGroup(html), /Song Identification/);
  // The track table is absent rather than empty.
  assert.doesNotMatch(html, /Self-reported local CogBench results<\/caption>/);
  assert.doesNotMatch(html, /<section aria-labelledby="untracked-reports-heading" class=/);
});

test("an id the catalog doesn't carry falls back to the id itself", () => {
  const unknown = report("report_unknown", "retired-benchmark", 3, "d", 0.25, "someone");
  const group = untrackedGroup(render({ scoped: [], untracked: [unknown] }));

  assert.match(group, /retired-benchmark<\/span> <span[^>]*>v3<\/span>/);
});

test("a failed untracked list shows the panel's error rather than a partial table", () => {
  const html = render({ scoped: [ON_TRACK], untrackedError: true });

  assert.match(html, /Synced local reports are temporarily unavailable/);
  assert.doesNotMatch(html, /untracked-reports-heading/);
});

test("nothing renders while there are no reports anywhere", () => {
  const html = render({ scoped: [], untracked: [] });

  assert.doesNotMatch(html, /local-reports-heading/);
});
