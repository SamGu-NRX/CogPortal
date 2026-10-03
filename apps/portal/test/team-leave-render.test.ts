import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";

/**
 * Leaving from the Team page, through the real stage guard, to the team
 * choice. The first version carried its "You left" notice in router state and
 * lost it in the browser: emptying the cached session made the Team page's
 * guard redirect to /connect after our own navigation, with no state. These
 * mount both guarded routes, as App does, so the guard is in the path.
 */

const TEAM_ID = "team_vision";
const TEAM_NAME = "Vision Squad";

function sessionFor(onTeam: boolean) {
  return {
    user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "bwsi-2026", name: "BWSI CogWorks 2026" },
    team: onTeam
      ? {
          id: TEAM_ID, name: TEAM_NAME, description: null, provenance: "live",
          repo: { owner: "octo", name: "face-finder", fullName: "octo/face-finder", url: "https://github.com/octo/face-finder", defaultBranch: "main" },
        }
      : null,
    auth: {
      githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
      appSlug: null, templateRepo: null, executionProvider: "fixture",
    },
  };
}

function teamDetail(members: number, teammateLogin = "teammate") {
  return {
    ...sessionFor(true).team,
    members: [
      { login: "student", name: null, avatarUrl: null, role: "write", isYou: true },
      ...(members > 1 ? [{ login: teammateLogin, name: null, avatarUrl: null, role: "admin", isYou: false }] : []),
    ],
    tas: [],
    isAdmin: false,
  };
}

/** Stands in for the worker. Requests the test does not care about answer
 *  404 in the API's own error shape, so a panel that wants them renders its
 *  error rather than throwing. */
function portal(options: { members: number; alreadyLeft?: boolean; holdLeave?: boolean; teammateLogin?: string }) {
  let onTeam = true;
  const leaves: unknown[] = [];
  let release = () => {};
  const fetch = async (input: string, init?: RequestInit) => {
    const path = new URL(input, "https://portal.example").pathname;
    if (path === "/api/session") return Response.json(sessionFor(onTeam));
    if (path === "/api/team" && onTeam) return Response.json(teamDetail(options.members, options.teammateLogin));
    if (path === "/api/team/leave") {
      leaves.push(JSON.parse(String(init?.body)));
      onTeam = false;
      const answer = Response.json({ alreadyLeft: options.alreadyLeft ?? false });
      if (!options.holdLeave) return answer;
      // The delete has committed; only the response is late.
      return new Promise<Response>((resolve) => { release = () => resolve(answer); });
    }
    if (path === "/api/cohorts/teams") return Response.json([]);
    if (path === "/api/github/repositories") return new Promise<Response>(() => {});
    return Response.json({ error: { code: "not_found", message: "Not here." } }, { status: 404 });
  };
  return { fetch, leaves, release: () => release() };
}

async function mount(t: TestContext, options: { members: number; alreadyLeft?: boolean; holdLeave?: boolean; teammateLogin?: string }) {
  const server = portal(options);
  const window = new Window({ url: "https://portal.example/team" });
  const globals: Record<string, unknown> = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    // Reduced motion, so /connect draws without its entrance: Happy DOM
    // rejects the animation Motion cancels when the test unmounts it.
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    fetch: server.fetch,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(window, "matchMedia", { configurable: true, value: globals.matchMedia });
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

  // Imported after the globals exist: Motion decides at module load whether
  // it is running in a browser.
  const { RequireStage } = await import("../src/App.tsx");
  const { TeamPage } = await import("../src/routes/TeamPage.tsx");
  const { ConnectPage } = await import("../src/routes/ConnectPage.tsx");
  let path = "";
  function Where() {
    path = useLocation().pathname;
    return null;
  }
  const guarded = (stage: "cohort" | "team", page: React.ComponentType) =>
    React.createElement(RequireStage, { stage }, React.createElement(page));
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: ["/team"] },
        React.createElement(Where),
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/team", element: guarded("team", TeamPage) }),
          React.createElement(Route, { path: "/connect", element: guarded("cohort", ConnectPage) }),
        ),
      ),
    ),
  ));
  await flush();
  return { container, server, client, flush, path: () => path };
}

async function pressLeaveTwice(container: HTMLElement, flush: () => Promise<void>) {
  const leave = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Leave"));
  assert.ok(leave, "no Leave on the student's own row");
  await act(async () => leave.click());
  await flush();
  assert.match(leave.textContent ?? "", /^Confirm, you leave/);
  await act(async () => leave.click());
  await flush();
}

test("leaving lands on the team choice and says which team, through the stage guard", async (t) => {
  const { container, server, flush, path } = await mount(t, { members: 2 });

  // Only the student's own row offers Leave; the teammate's has no control.
  const rows = [...container.querySelectorAll("li")].filter((row) => /student|teammate/.test(row.textContent ?? ""));
  assert.equal(rows.filter((row) => /Leave/.test(row.textContent ?? "")).length, 1);

  await pressLeaveTwice(container, flush);

  assert.deepEqual(server.leaves, [{ teamId: TEAM_ID }]);
  assert.equal(path(), "/connect");
  const notice = [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.equal(
    notice?.textContent,
    `You left ${TEAM_NAME}Its runs and results stay with the team. If GitHub still gives you write access to its repository, you can join it again below.`,
  );
});

test("the armed Leave says what stays, and the last member hears the team stays joinable", async (t) => {
  const { container, flush } = await mount(t, { members: 1 });
  const leave = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Leave"));
  assert.ok(leave);
  assert.equal(container.querySelector("li [role=status]"), null, "the consequence shows only while armed");
  await act(async () => leave.click());
  await flush();
  assert.equal(
    container.querySelector("li [role=status]")?.textContent,
    "You're the last member, so the team will be empty. It keeps its repository, runs and results, and anyone with write access on GitHub can join it again.",
  );
});

test("a leave another tab already made is reported as such, not as a fresh one", async (t) => {
  const { container, flush } = await mount(t, { members: 2, alreadyLeft: true });
  await pressLeaveTwice(container, flush);
  const notice = [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.match(notice?.textContent ?? "", /^You'd already left Vision Squad/);
});

test("a refetch that reaches /connect before the leave answers still shows the notice", async (t) => {
  const { container, server, client, flush, path } = await mount(t, { members: 2, holdLeave: true });
  await pressLeaveTwice(container, flush);
  // Any refetch now sees the committed leave and the guard redirects first.
  await act(async () => { await client.invalidateQueries(); });
  // The guard's redirect can land a tick after act returns, so wait for the
  // state itself: on /connect with the team choice drawn.
  const choiceDrawn = () => path() === "/connect" && !/Checking the cohort/.test(container.textContent ?? "");
  for (let i = 0; i < 50 && !choiceDrawn(); i += 1) await flush();
  assert.equal(path(), "/connect");
  assert.doesNotMatch(container.textContent ?? "", /Checking the cohort/, "the team choice must be drawn before the leave answers");
  const leftNotice = () => [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.equal(leftNotice(), undefined, "nothing to say until the leave has answered");
  await act(async () => server.release());
  await flush();
  assert.match(leftNotice()?.textContent ?? "", /^You left Vision Squad/);
});

test("when a teammate shows the same login, only the reader's own row offers Leave", async (t) => {
  // Two accounts can display one login (a development account beside a GitHub
  // one); the row is chosen by the server's isYou, not by comparing logins.
  const { container, flush } = await mount(t, { members: 2, teammateLogin: "student" });
  const rows = [...container.querySelectorAll("li")].filter((row) => /student/.test(row.textContent ?? ""));
  assert.equal(rows.length, 2);
  const withLeave = rows.filter((row) => [...row.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Leave")));
  assert.equal(withLeave.length, 1, "Leave appeared on more than the reader's row");
  const saysYou = (row: Element) => [...row.querySelectorAll("span")].some((span) => span.textContent === "you");
  assert.ok(saysYou(withLeave[0]), "the row with Leave is not the one marked as the reader");
  assert.equal(rows.filter(saysYou).length, 1, "more than one row says you");
  const leave = [...withLeave[0].querySelectorAll("button")].find((b) => b.textContent?.startsWith("Leave"))!;
  await act(async () => leave.click());
  await flush();
  assert.equal(container.querySelectorAll("li [role=status]").length, 1, "the consequence showed under more than one row");
});
