import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { ConnectPage } from "../src/routes/ConnectPage.tsx";
import { ConnectionsPage } from "../src/routes/ConnectionsPage.tsx";
import { SetupPage } from "../src/routes/SetupPage.tsx";

// The three pages answer three different questions, and each is covered on
// its own (connect-wizard, connections-device-recovery, setup-rail). What no
// single page test can say is that the hand-offs between them land a student
// on a coherent journey: a created or joined team arrives on Setup with the
// arrival note and commands naming THAT team's repository, and approving a
// device on the approval page ticks Setup's link step through the polls
// without anybody reloading. These tests drive the real pages across real
// route changes against one stateful stand-in for the worker.

const BENCHMARK = {
  id: "vision-recognition",
  version: 1,
  contractVersion: "cogworks.submissions.v1",
  entryPointName: "vision-recognition",
  title: "Face recognition",
  module: "vision",
  summary: "Recognize faces.",
  active: true,
  pluginVersion: "1",
  datasetVersion: "1",
  scorerVersion: "1",
  runtimeVersion: "1",
};

const FORK = {
  repositoryId: 9001,
  owner: "cogworks-demo",
  name: "face-finder",
  fullName: "cogworks-demo/face-finder",
  url: "https://github.com/cogworks-demo/face-finder",
  defaultBranch: "main",
  branches: ["main"],
  claimedByTeam: null,
  description: "Vision capstone fork",
  isFork: true,
  pushedAt: Date.now() - 3_600_000,
};

const JOINED_TEAM = {
  id: "team_search",
  name: "Search Squad",
  description: null,
  provenance: "live",
  repo: { fullName: "cogworks-demo/search-engine", url: "https://github.com/cogworks-demo/search-engine" },
  members: [{ login: "teammate", name: null, avatarUrl: null, role: "admin", isYou: false }],
  adminLogin: "teammate",
};

/** One shared, mutable worker. Every read answers from the same state the
 *  writes left behind, which is the thing a journey test has to hold. */
function portal(options: { cohortTeams?: typeof JOINED_TEAM[] } = {}) {
  let state = {
    team: null as null | Record<string, unknown>,
    repositories: [FORK] as typeof FORK[],
    cohortTeams: (options.cohortTeams ?? []) as typeof JOINED_TEAM[],
    cliDevices: [] as { id: string; name: string; createdAt: number; lastUsedAt: null }[],
    approvedCodes: [] as string[],
  };
  const session = () => ({
    user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "bwsi-2026", name: "BWSI CogWorks 2026" },
    team: state.team,
    auth: {
      githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
      appSlug: null, templateRepo: "cogworks-demo/cogworks-vision-capstone",
      executionProvider: "fixture",
    },
  });
  const fetch = async (input: string | URL, init?: { body?: unknown }) => {
    const url = new URL(input, "https://portal.example");
    const path = url.pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (path === "/api/session") return Response.json(session());
    if (path === "/api/cohorts/teams") return Response.json(state.cohortTeams);
    if (path === "/api/github/repositories") return Response.json(state.repositories);
    if (path === "/api/github/installations") return Response.json([{ id: 7, account: "cogworks-demo", accountType: "User", avatarUrl: null }]);
    if (path === "/api/benchmarks") return Response.json([BENCHMARK]);
    if (path === "/api/team") return Response.json(state.team ? { ...state.team, members: [], tas: [], isAdmin: false } : null);
    if (path === "/api/github/connect") {
      // Starting a team claims the chosen repository under the new team and
      // answers with the whole signed-in session (the schema is SessionSchema).
      state = {
        ...state,
        team: {
          id: "team_new", name: body.teamName as string, description: null, provenance: "live",
          repo: { owner: FORK.owner, name: FORK.name, fullName: FORK.fullName, url: FORK.url, defaultBranch: "main" },
        },
      };
      return Response.json(session());
    }
    if (path === "/api/team/join") {
      const team = state.cohortTeams.find((t) => t.id === body.teamId);
      if (!team) return Response.json({ error: { code: "not_found", message: "Team not found." } }, { status: 404 });
      state = {
        ...state,
        team: {
          id: team.id, name: team.name, description: team.description, provenance: team.provenance,
          repo: { owner: "cogworks-demo", name: "search-engine", fullName: "cogworks-demo/search-engine", url: team.repo.url, defaultBranch: "main" },
        },
      };
      return Response.json({ ...state.team, members: [...team.members, { login: "student", name: null, avatarUrl: null, role: "write", isYou: true }], tas: [], isAdmin: false });
    }
    if (path === "/api/v1/connections") {
      return Response.json({ github: null, discord: null, cliDevices: state.cliDevices });
    }
    if (path === "/api/v1/setup/state") {
      return Response.json({ verified: [], verifiedByBenchmark: {}, checked: [], checkedByBenchmark: {}, tokens: {} });
    }
    if (path === "/api/v1/cli/device/status") {
      const code = url.searchParams.get("user_code") ?? "";
      return Response.json({ valid: true, approved: state.approvedCodes.includes(code), expiresAt: Date.now() + 600_000 });
    }
    if (path === "/api/v1/cli/device/approve") {
      if (!state.approvedCodes.includes(body.userCode)) state.approvedCodes.push(body.userCode);
      state = { ...state, cliDevices: [...state.cliDevices, { id: "d1", name: body.deviceName as string, createdAt: Date.now(), lastUsedAt: null }] };
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected request ${path}`);
  };
  return { fetch, state: () => state };
}

type FetchStub = (input: string | URL, init?: { body?: unknown }) => Promise<Response>;

async function mountJourney(t: test.TestContext, initialPath: string, fetch: FetchStub) {
  const window = new Window({ url: `https://portal.example${initialPath}` });
  const globals: Record<string, unknown> = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React DOM uses.
  const root = createRoot(container as unknown as Element);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The pages navigate; the test reads the location and drives navigation the
  // way the CLI's printed approval URL does (no rendered link leads there).
  const here = { path: initialPath, navigate: (to: string) => {} };
  const probe = React.createElement(function Probe() {
    const location = useLocation();
    const navigate = useNavigate();
    here.path = location.pathname + location.search;
    here.navigate = (to: string) => navigate(to);
    return null;
  });
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
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [initialPath] },
        React.createElement(React.Fragment, null,
          probe,
          React.createElement(Routes, null,
            React.createElement(Route, { path: "/connect", element: React.createElement(ConnectPage) }),
            React.createElement(Route, { path: "/setup", element: React.createElement(SetupPage) }),
            React.createElement(Route, { path: "/connections", element: React.createElement(ConnectionsPage) }),
          ),
        ),
      ),
    ),
  ));
  const flush = () => act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const click = async (pattern: RegExp) => {
    // Radio rows are labels wrapping an input, so the control itself may be
    // the label or the radio inside it.
    const node = [...container.querySelectorAll("button, a, label")]
      .find((el) => pattern.test(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""));
    assert.ok(node, `no control matches ${pattern}`);
    const input = node.matches("label") ? node.querySelector("input") : null;
    await act(async () => (input ?? node).click());
    await flush();
  };
  return { container, flush, settle, click, here };
}

test("a created team lands on Setup with its arrival note and commands, and an approved device ticks the link step", async (t) => {
  const server = portal();
  const { container, flush, settle, click, here } = await mountJourney(t, "/connect", server.fetch);

  // No cohort teams yet: the start form is the whole wizard.
  await flush();
  await click(/^face-finder$|cogworks-demo\/face-finder/);
  await click(/^Create /);

  // The create navigation carries the arrival note, and the commands name
  // the repository the team was started from — not the course template.
  assert.equal(here.path, "/setup", "create did not land on Setup");
  const text = () => container.textContent ?? "";
  assert.match(text(), /You've created Face Finder/);
  assert.match(text(), /git clone https:\/\/github\.com\/cogworks-demo\/face-finder\.git/);
  assert.match(text(), /0 of 5 done/);

  // The CLI's printed approval URL opens on the approval page; approving
  // returns the student here within the second, and the link step ticks off
  // the next poll — the student never reloads.
  here.navigate("/connections?user_code=JOURNEY-CODE-1&return_to=setup");
  await flush();
  await click(/^Approve device$/);
  await settle(1300); // the approval settles, then the 900ms return timer
  assert.equal(here.path, "/setup", "approval did not return to Setup");
  await settle(4800); // the connections poll (4s while the list reads empty)
  assert.match(text(), /1 of 5 done/);
  assert.match(text(), /seen by the portal/);
});

test("a student joining a cohort team arrives on Setup with the joined note and the joined team's repository", async (t) => {
  const server = portal({ cohortTeams: [JOINED_TEAM] });
  const { container, flush, click, here } = await mountJourney(t, "/connect", server.fetch);

  await flush();
  await click(/^Join a team someone already started$/);
  await click(/^Join Search Squad$/);

  assert.equal(here.path, "/setup", "join did not land on Setup");
  const text = () => container.textContent ?? "";
  assert.match(text(), /You're on Search Squad/);
  assert.match(text(), /git clone https:\/\/github\.com\/cogworks-demo\/search-engine\.git/);
  assert.match(text(), /0 of 5 done/);
});
