import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";

// The team wizard reads the student's GitHub repositories only to suggest
// which team is probably theirs. That listing goes through GitHub and has no
// client timeout, so these tests hold it open forever and check that the
// cohort's team list alone is enough to join, and that a join finishes while
// the listing is still stalled.

const TEAM = {
  id: "team_vision",
  name: "Vision Squad",
  description: null,
  provenance: "live",
  repo: { fullName: "octo/face-finder", url: "https://github.com/octo/face-finder" },
  members: [{ login: "teammate", name: null, avatarUrl: null, role: "admin", isYou: false }],
  adminLogin: "teammate",
};

function sessionFor(team: boolean) {
  return {
    user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "bwsi-2026", name: "BWSI CogWorks 2026" },
    team: team
      ? {
          id: TEAM.id, name: TEAM.name, description: null, provenance: "live",
          repo: { owner: "octo", name: "face-finder", fullName: "octo/face-finder", url: TEAM.repo.url, defaultBranch: "main" },
        }
      : null,
    auth: {
      githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
      appSlug: null, templateRepo: null, executionProvider: "fixture",
    },
  };
}

/** Stands in for the worker. The repository listing never answers; the join
 *  answers when the test releases it, as a real request takes a round trip. */
function portal(teams: typeof TEAM[] = [TEAM]) {
  let joined = false;
  let releaseJoin: (() => void) | null = null;
  // What the join answers: its success, the server's refusal for a student a
  // membership elsewhere already holds, or a dropped connection.
  let joinAnswer: "ok" | "already_on_team" | "network" = "ok";
  let joinWrites = 0;
  const requests: string[] = [];
  const fetch = async (input: string) => {
    const path = new URL(input, "https://portal.example").pathname;
    requests.push(path);
    if (path === "/api/session") return Response.json(sessionFor(joined));
    if (path === "/api/cohorts/teams") return Response.json(teams);
    if (path === "/api/github/repositories") return new Promise<Response>(() => {});
    if (path === "/api/team/join") {
      if (joinAnswer === "network") throw new TypeError("Failed to fetch");
      if (joinAnswer === "already_on_team") {
        return Response.json({ error: { code: "already_on_team", message: "You are already on a team." } }, { status: 409 });
      }
      joinWrites += 1;
      return new Promise<Response>((resolve) => {
        releaseJoin = () => {
          joined = true;
          resolve(Response.json({
            ...sessionFor(true).team,
            members: [...TEAM.members, { login: "student", name: null, avatarUrl: null, role: "write", isYou: true }],
            tas: [],
            isAdmin: false,
          }));
        };
      });
    }
    throw new Error(`unexpected request ${path}`);
  };
  return {
    fetch,
    requests,
    answerJoin: (mode: "ok" | "already_on_team" | "network") => { joinAnswer = mode; },
    joinWrites: () => joinWrites,
    releaseJoin() {
      assert.ok(releaseJoin, "the join request was never sent");
      releaseJoin();
    },
  };
}

function installGlobals(t: TestContext, extra: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://portal.example/connect" });
  const globals: Record<string, unknown> = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    React, IS_REACT_ACT_ENVIRONMENT: true,
    ...extra,
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
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const flush = () => act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { window, container, root, client, flush };
}

async function mountWizard(t: TestContext, entry: string, teams?: typeof TEAM[]) {
  const server = portal(teams);
  const env = installGlobals(t, { fetch: server.fetch });
  // Imported after the globals exist: Motion decides at module load whether
  // it is running in a browser.
  const { ConnectPage } = await import("../src/routes/ConnectPage.tsx");
  let arrival: unknown;
  function SetupMarker() {
    arrival = useLocation().state;
    return React.createElement("p", null, "setup page");
  }
  await act(async () => env.root.render(
    React.createElement(QueryClientProvider, { client: env.client },
      React.createElement(MemoryRouter, { initialEntries: [entry] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/connect", element: React.createElement(ConnectPage) }),
          React.createElement(Route, { path: "/setup", element: React.createElement(SetupMarker) }),
          React.createElement(Route, { path: "/dashboard", element: React.createElement("p", null, "dashboard") }),
        ),
      ),
    ),
  ));
  await env.flush();
  return { ...env, server, arrival: () => arrival };
}

// First in the file on purpose: Motion reads the reduced-motion preference
// once per process and caches it, so this has to be the first render.
test("the progress rule is drawn in full on arrival when the student prefers reduced motion", async (t) => {
  const reduce = (query: string) => ({
    matches: query === "(prefers-reduced-motion)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  const env = installGlobals(t);
  // Motion asks window.matchMedia once, on first use.
  Object.defineProperty(env.window, "matchMedia", { configurable: true, value: reduce });
  const { OnboardingPath } = await import("../src/components/OnboardingPath.tsx");
  await act(async () => env.root.render(React.createElement(OnboardingPath, { current: "team" })));

  const current = env.container.querySelector('[aria-current="step"]');
  assert.ok(current);
  const rule = current.querySelector<HTMLElement>("span[aria-hidden] > span");
  assert.ok(rule, "the current step has no progress rule");
  assert.doesNotMatch(rule.getAttribute("style") ?? "", /scaleX\(0\)/);
});

test("the join screen offers the cohort's teams while the repository listing is still pending", async (t) => {
  const { container, server } = await mountWizard(t, "/connect?path=join");

  assert.ok(server.requests.includes("/api/github/repositories"), "the listing was never asked for");
  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /Checking the cohort/);
  assert.match(text, /Join your team/);
  assert.ok(container.querySelector('button[aria-label="Join Vision Squad"]'));
});

test("the choice screen does not wait for the repository listing either", async (t) => {
  const { container } = await mountWizard(t, "/connect");

  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /Checking the cohort/);
  assert.match(text, /Join a team someone already started/);
  // The suggestion needs the listing, so it stays away until it answers.
  assert.equal(container.querySelector("#likely-team"), null);
});

test("a join reaches /setup while the repository listing never answers", async (t) => {
  const { container, server, flush, arrival } = await mountWizard(t, "/connect?path=join");

  const join = container.querySelector<HTMLButtonElement>('button[aria-label="Join Vision Squad"]');
  assert.ok(join);
  await act(async () => join.click());
  await flush();
  server.releaseJoin();
  await flush();

  assert.match(container.textContent ?? "", /setup page/);
  assert.deepEqual(arrival(), { arrivedFrom: "joined", teamName: "Vision Squad" });
});

function cohortOf(count: number): typeof TEAM[] {
  return Array.from({ length: count }, (_, index) => ({
    ...TEAM,
    id: `team_${index}`,
    name: `Team ${index + 1}`,
    repo: { fullName: `octo/team-${index + 1}`, url: `https://github.com/octo/team-${index + 1}` },
  }));
}

const joinButtons = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Join "]')]
    .filter((button) => !button.closest("[inert]"));

test("a short cohort lists every team rather than folding one or two away", async (t) => {
  const { container } = await mountWizard(t, "/connect?path=join", cohortOf(7));

  assert.equal(joinButtons(container).length, 7);
  assert.doesNotMatch(container.textContent ?? "", /See \d+ more team/);
});

test("a long cohort folds the rest behind one press", async (t) => {
  const { container } = await mountWizard(t, "/connect?path=join", cohortOf(8));

  assert.equal(joinButtons(container).length, 5);
  assert.match(container.textContent ?? "", /See 3 more teams/);
});

test("a join refused because a membership elsewhere already holds the student offers the current team", async (t) => {
  // This Connect page loaded with no team; a join in another window, on
  // another device or by staff landed since. The refusal is right; the page
  // just cannot show that team, so it offers a full load of /team.
  const { container, server, flush } = await mountWizard(t, "/connect?path=join");
  server.answerJoin("already_on_team");
  const join = container.querySelector<HTMLButtonElement>('button[aria-label="Join Vision Squad"]');
  await act(async () => join!.click());
  await flush();
  const alert = container.querySelector('[role="alert"]');
  assert.match(alert?.textContent ?? "", /You're already on a team; this page was opened before you joined it\./);
  const open = [...(alert?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Open your current team");
  assert.equal(open?.getAttribute("href"), "/team");
  // A plain link, so the browser loads the page afresh; a router Link would
  // keep this page's stale session and its pending callbacks.
  assert.equal(open?.hasAttribute("data-discover"), false, "the recovery is a router Link");
  assert.equal(server.joinWrites(), 0, "the refused join wrote a membership");
});

test("a join whose connection drops keeps the try-again message, not the current-team link", async (t) => {
  const { container, server, flush } = await mountWizard(t, "/connect?path=join");
  server.answerJoin("network");
  const join = container.querySelector<HTMLButtonElement>('button[aria-label="Join Vision Squad"]');
  await act(async () => join!.click());
  await flush();
  const alert = container.querySelector('[role="alert"]');
  assert.equal(alert?.textContent, "Could not reach the portal. Check your connection and try again.");
  assert.equal(container.querySelector('a[href="/team"]'), null);
  // The row stays pressable for the retry.
  assert.equal(join?.disabled, false);
});
