import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  StaffDeskRunListSchema,
  StaffDeskTeamDetailSchema,
  StaffDeskTeamListSchema,
  type StaffDeskHistoryState,
} from "@cogworks/contracts/schema";
import { AdminOverviewSchema } from "@cogworks/contracts/schema";
import { AdminPage } from "../src/routes/AdminPage.tsx";
import { StaffDeskPage, StaffDeskTeamPage } from "../src/routes/StaffDeskPage.tsx";

/**
 * The staff desk page and the admin page under each staff view, rendered from
 * parsed contract fixtures (the same schemas the routes answer with). What is
 * measured: the page states each history status in words instead of standing
 * an unusable read in for the team's work, and a restricted view says what it
 * withheld instead of reading as an empty team.
 */

const NOW = Date.now();
const fresh: StaffDeskHistoryState = { status: "fresh", checkedAt: NOW - 5 * 60_000, stale: false, forConnectedRepository: true };
const neverRead: StaffDeskHistoryState = { status: "never_read", checkedAt: null, stale: false, forConnectedRepository: false };
const otherBranch: StaffDeskHistoryState = { status: "other_branch", checkedAt: NOW - 60_000, stale: false, forConnectedRepository: false };

function row(id: string, name: string, history: StaffDeskHistoryState, firstLight: boolean) {
  return {
    id,
    name,
    cohortId: "cohort_test",
    repo: { fullName: `course/${id}`, defaultBranch: "main" },
    memberCount: 2,
    taLogins: ["tessa"],
    historyQuality: history.forConnectedRepository ? "usable" : null,
    history,
    weekLabel: "week1",
    firstLight: firstLight ? { benchmarkId: "audio-identification", benchmarkTitle: "Audio identification", at: NOW - 86_400_000 } : null,
    scoredRunCount: firstLight ? 3 : 0,
    runsElsewhere: false,
  };
}

function render(element: React.ReactElement, path: string, data: [unknown[], unknown][]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of data) client.setQueryData(key, value);
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemoryRouter, { initialEntries: [path] }, element),
    ),
  );
  client.clear();
  return html;
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("the desk list opens with the team that has no scored run and names each history state", () => {
  const list = StaffDeskTeamListSchema.parse({
    scope: "ta",
    view: "full",
    teams: [row("team_a", "Alpha", fresh, true), row("team_b", "Bravo", neverRead, false), row("team_c", "Charlie", otherBranch, true)],
  });
  const html = text(render(React.createElement(StaffDeskPage), "/desk", [[["admin", "desk", "teams"], list]]));
  assert.ok(html.indexOf("Bravo") < html.indexOf("Alpha"), "a team without a scored run sorts first");
  assert.match(html, /No scored run yet/);
  assert.match(html, /History not read yet/);
  assert.match(html, /History is of another branch/);
  assert.match(html, /History read 5 min ago/);
  assert.doesNotMatch(html, /restricted staff setting/);
});

function detail(view: "full" | "restricted", history: StaffDeskHistoryState) {
  return StaffDeskTeamDetailSchema.parse({
    scope: "ta",
    view,
    team: {
      id: "team_a",
      name: "Alpha",
      description: null,
      repo: { fullName: "course/team_a", defaultBranch: "main" },
      memberCount: 2,
      members: view === "full" ? [{ login: "zq-student-one", role: "admin" }, { login: "zq-student-two", role: "write" }] : [],
      tas: [{ login: "tessa" }],
    },
    commitSignals:
      view === "full" && history.forConnectedRepository
        ? {
            historyQuality: "usable",
            historyWindow: { commits: 2, truncated: false },
            weekLabel: "week1",
            stageFootprint: {},
            ownershipBreadth: {},
            findingSentences: ["Two people have touched the spectrogram stage."],
          }
        : null,
    history,
    weekLabel: "week1",
    firstLight: null,
    runsElsewhere: false,
  });
}

const RUNS = StaffDeskRunListSchema.parse({
  scope: "ta",
  view: "full",
  page: 1,
  pageSize: 20,
  total: 1,
  hasMore: false,
  runs: [
    {
      runId: "run_1",
      status: "failed",
      mode: "practice",
      benchmarkId: "audio-identification",
      benchmarkTitle: "Audio identification",
      attemptNumber: null,
      createdAt: NOW - 3_600_000,
      finishedAt: NOW - 3_500_000,
      activity: "terminal",
      evidence: "connected",
      repositoryFullName: "course/team_a",
      failurePhase: "evaluating",
      failureCategory: "student_runtime",
      preparedSnapshot: { recorded: false, environmentDigest: null },
    },
  ],
});

function renderTeam(data: ReturnType<typeof detail>) {
  return text(
    render(
      React.createElement(Routes, null, React.createElement(Route, { path: "/desk/:teamId", element: React.createElement(StaffDeskTeamPage) })),
      "/desk/team_a",
      [
        [["admin", "desk", "team", "team_a"], data],
        [["admin", "desk", "runs", "team_a", 1], RUNS],
      ],
    ),
  );
}

test("a team page shows findings only for a read of its own branch, and says why otherwise", () => {
  const current = renderTeam(detail("full", fresh));
  assert.match(current, /Two people have touched the spectrogram stage\./);
  assert.match(current, /Read 5 min ago from main/);
  assert.match(current, /zq-student-one/);
  assert.match(current, /Stopped at Evaluate · E-RUNTIME/);

  const elsewhere = renderTeam(detail("full", otherBranch));
  assert.match(elsewhere, /The last read was of a branch other than main/);
  assert.match(elsewhere, /Nothing to report until there's a read of this repository and branch/);
  assert.doesNotMatch(elsewhere, /spectrogram/);
});

test("a restricted team page says what it withheld and names no student", () => {
  const html = renderTeam(detail("restricted", fresh));
  assert.match(html, /restricted staff setting/);
  assert.match(html, /2 students\. Names are withheld\./);
  assert.match(html, /Process findings are withheld/);
  assert.doesNotMatch(html, /zq-student/);
  assert.match(html, /tessa/, "staff names stay");
});

test("a restricted admin overview says names and scores were withheld instead of showing an empty team", () => {
  const overview = AdminOverviewSchema.parse({
    scope: "ta",
    view: "restricted",
    cohort: { slug: "test", name: "Test cohort", joinCode: null, active: true },
    unassigned: [],
    teams: [
      {
        id: "team_a",
        name: "Alpha",
        provenance: "live",
        repoFullName: "course/team_a",
        memberCount: 2,
        members: [],
        tas: [{ login: "tessa", name: null, avatarUrl: null }],
        practiceUsed: 1,
        officialUsed: 0,
        hostedRuns: 2,
        refundsGiven: 0,
        firstLight: null,
        lastHostedRun: null,
        published: null,
      },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "overview"], overview);
  const html = text(
    renderToStaticMarkup(
      React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(AdminPage))),
    ),
  );
  client.clear();
  assert.match(html, /restricted staff setting/);
  assert.doesNotMatch(html, /Nobody is on this team/);
});
