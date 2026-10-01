import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Session } from "@cogworks/contracts/schema";
import { nextStagePath, RequireStage, RequireStaff } from "../src/App.tsx";
import { AdminPage } from "../src/routes/AdminPage.tsx";
import { SignInPage } from "../src/routes/SignInPage.tsx";
import { rememberConnectionReturn } from "../src/lib/pending-return.ts";

/**
 * B-48: staff and TAs without a team of their own were routed into student
 * onboarding. They belong in the admin console; a student's path, staff with
 * a team, and /connect asked for by name are unchanged.
 */

type Role = "student" | "staff" | "ta";

function session(role: Role, { cohort = true, team = false } = {}): Session {
  return {
    user: {
      login: `${role}-fixture`,
      name: null,
      avatarUrl: null,
      platformRole: role === "staff" ? "staff" : "student",
      isOwner: false,
      isTa: role === "ta",
    },
    cohort: cohort ? { slug: "bwsi", name: "BWSI" } : null,
    team: team ? { id: "team_1", name: "Team One", description: null, provenance: "live", repo: null } : null,
    auth: {
      githubConfigured: true,
      devAuthEnabled: false,
      onboardingDevToolsEnabled: false,
      appSlug: null,
      templateRepo: null,
      executionProvider: "fixture",
    },
  };
}

test("the default landing follows the role matrix", () => {
  assert.equal(nextStagePath({ ...session("student"), user: null }), "/signin");
  assert.equal(nextStagePath(session("student", { cohort: false })), "/join");
  assert.equal(nextStagePath(session("student")), "/connect");
  assert.equal(nextStagePath(session("student", { team: true })), "/dashboard");
  assert.equal(nextStagePath(session("staff", { cohort: false })), "/admin");
  assert.equal(nextStagePath(session("staff")), "/admin");
  assert.equal(nextStagePath(session("ta", { cohort: false })), "/admin");
  assert.equal(nextStagePath(session("staff", { team: true })), "/dashboard");
  assert.equal(nextStagePath(session("ta", { team: true })), "/dashboard");
});

/** Mounts the guarded routes the way App does, with stub pages that name
 *  themselves, and reports where navigation settled. `pendingReturn` is the
 *  connection link a signed-out visit saved before sign-in. */
async function navigate(value: Session, entry: string, { pendingReturn = "", realAdmin = false } = {}) {
  const window = new Window({ url: `https://portal.example${entry}` });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement, Element: window.Element,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, val] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: val });
  }
  // Seeded and never stale, so no guard reaches for the network.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["session"], value);
  client.setQueryData(["admin", "overview"], {
    scope: "ta", cohort: { slug: "bwsi", name: "BWSI", joinCode: null, active: true }, teams: [], unassigned: [],
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations used by React DOM.
  const root = createRoot(container as unknown as Element);
  if (pendingReturn) rememberConnectionReturn(pendingReturn);

  let settled = "";
  function Where({ page }: { page: string }) {
    const location = useLocation();
    settled = `${page} ${location.pathname}${location.search}`;
    return React.createElement("p", null, page);
  }
  const page = (name: string, stage?: "user" | "cohort" | "team") =>
    stage
      ? React.createElement(RequireStage, { stage }, React.createElement(Where, { page: name }))
      : React.createElement(Where, { page: name });

  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [entry] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/signin", element: React.createElement(SignInPage) }),
          React.createElement(Route, { path: "/join", element: page("join", "user") }),
          React.createElement(Route, { path: "/connect", element: page("connect", "cohort") }),
          React.createElement(Route, { path: "/connections", element: page("connections", "team") }),
          React.createElement(Route, { path: "/dashboard", element: page("dashboard", "team") }),
          React.createElement(Route, { path: "/setup", element: page("setup", "team") }),
          React.createElement(Route, {
            path: "/admin",
            element: React.createElement(RequireStaff, null,
              realAdmin ? React.createElement(React.Fragment, null, React.createElement(AdminPage), React.createElement(Where, { page: "admin" }))
                : React.createElement(Where, { page: "admin" })),
          }),
          React.createElement(Route, { path: "/", element: page("front") }),
        ),
      ),
    ),
  ));
  const keptReturn = window.sessionStorage.getItem("cogportal.pendingReturn");
  const text = container.textContent ?? "";
  const links = [...container.querySelectorAll("a")].map((node) => [node.textContent, node.getAttribute("href")]);
  await act(async () => root.unmount());
  client.clear();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  return { settled, keptReturn, text, links };
}

test("staff and TAs without a team enter the console from team pages and sign-in", async () => {
  for (const [role, entry] of [
    ["staff", "/dashboard"],
    ["ta", "/setup"],
    ["staff", "/signin"],
    ["ta", "/signin"],
  ] as const) {
    const { settled } = await navigate(session(role, { cohort: false }), entry);
    assert.equal(settled, "admin /admin", `${role} at ${entry}`);
  }
});

test("a student still walks the onboarding steps they owe", async () => {
  assert.equal((await navigate(session("student", { cohort: false }), "/dashboard")).settled, "join /join");
  assert.equal((await navigate(session("student"), "/dashboard")).settled, "connect /connect");
  assert.equal((await navigate(session("student"), "/signin")).settled, "connect /connect");
  assert.equal((await navigate(session("student"), "/admin")).settled, "front /");
});

test("staff with a team keep their runs, and /connect asked for by name stays onboarding", async () => {
  assert.equal((await navigate(session("staff", { team: true }), "/signin")).settled, "dashboard /dashboard");
  assert.equal((await navigate(session("ta", { team: true }), "/setup")).settled, "setup /setup");
  assert.equal((await navigate(session("staff"), "/connect")).settled, "connect /connect");
  assert.equal((await navigate(session("staff", { cohort: false }), "/connect")).settled, "join /join");
});

test("a pending device approval returns staff with a team to it after sign-in", async () => {
  const { settled } = await navigate(
    session("staff", { team: true }),
    "/signin",
    { pendingReturn: "/connections?user_code=ABCD-EFGH-IJKL&return_to=setup" },
  );
  assert.equal(settled, "connections /connections?user_code=ABCD-EFGH-IJKL&return_to=setup");
});

test("teamless staff are not left looping on an approval the server would refuse", async () => {
  // Device approval needs a team (requireTeam in worker/routes/connections.ts),
  // so the return is dropped on the way to the console, not kept to bounce
  // every later visit to `/` back through /connections.
  const { settled, keptReturn } = await navigate(
    session("staff", { cohort: false }),
    "/signin",
    { pendingReturn: "/connections?user_code=ABCD-EFGH-IJKL" },
  );
  assert.equal(settled, "admin /admin");
  assert.equal(keptReturn, null);
});

test("teamless staff who follow a device link learn on the console why it waits", async () => {
  // The approval needs a team, so the guard sends them to the console. It
  // used to say nothing there while `cogworks link` kept polling.
  const { settled, text, links } = await navigate(
    session("staff", { cohort: false }),
    "/connections?user_code=ABCD-EFGH-IJKL&return_to=setup",
    { realAdmin: true },
  );
  assert.equal(settled, "admin /admin");
  assert.match(text, /Your device link is on hold/);
  assert.match(text, /Ctrl\+C stops it/);
  assert.ok(text.includes("cogworks link --portal https://portal.example"));
  // Joining a team is offered, not required: the link goes to onboarding by
  // name, and nothing is approved or changed on the way.
  assert.deepEqual(links, [["join a team", "/connect"]]);
});
