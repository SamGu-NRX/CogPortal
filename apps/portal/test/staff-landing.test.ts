import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Session } from "@cogworks/contracts/schema";
import { nextStagePath, RequireStage, RequireStaff } from "../src/App.tsx";
import { AdminPage } from "../src/routes/AdminPage.tsx";
import { Landing } from "../src/routes/Landing.tsx";
import { SignInPage } from "../src/routes/SignInPage.tsx";
import { ConnectionsPage } from "../src/routes/ConnectionsPage.tsx";
import { pendingReturn, rememberReturn } from "../src/lib/pending-return.ts";

/**
 * Where sign-in and the stage guards send people.
 *
 * B-48: staff and TAs without a team of their own were routed into student
 * onboarding. They belong in the admin console; a student's path, staff with
 * a team, and /connect asked for by name are unchanged.
 *
 * B-58: a signed-out visitor opening a run or its console from Discord or the
 * Activity lost the run at sign-in. B-69: a device or Discord approval that
 * was abandoned, expired or refused kept redirecting `/` and /signin to the
 * dead form for the rest of the tab.
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
 *  themselves (the real Landing and ConnectionsPage, whose redirects and
 *  approval form are under test), and reports where navigation settled.
 *  `saved` is the link a signed-out visit stored before sign-in. After the
 *  first page settles, `during` runs on it, `signInAs` replaces the session the
 *  way a dev sign-in's refetch does, and `then` is each later in-app
 *  navigation. `realAdmin` renders the real AdminPage at /admin. */
async function navigate(
  value: Session,
  entry: string,
  {
    saved = "",
    during,
    signInAs,
    then = [],
    realAdmin = false,
  }: {
    saved?: string;
    during?: (window: Window) => Promise<void>;
    signInAs?: Session;
    then?: string[];
    realAdmin?: boolean;
  } = {},
) {
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
  client.setQueryData(["connections"], { github: null, discord: null, cliDevices: [] });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations used by React DOM.
  const root = createRoot(container as unknown as Element);
  if (saved) rememberReturn(saved);

  let settled = "";
  let go: (to: string) => void = () => {};
  function Where({ page }: { page: string }) {
    const location = useLocation();
    go = useNavigate();
    settled = `${page} ${location.pathname}${location.search}${location.hash}`;
    return React.createElement("p", null, page);
  }
  const real = (name: string, element: React.ReactElement) =>
    React.createElement(React.Fragment, null, element, React.createElement(Where, { page: name }));
  const page = (name: string, stage?: "user" | "cohort" | "team") =>
    stage
      ? React.createElement(RequireStage, { stage }, React.createElement(Where, { page: name }))
      : React.createElement(Where, { page: name });

  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [entry] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/signin", element: real("signin", React.createElement(SignInPage)) }),
          React.createElement(Route, { path: "/join", element: page("join", "user") }),
          React.createElement(Route, { path: "/connect", element: page("connect", "cohort") }),
          React.createElement(Route, {
            path: "/connections",
            element: React.createElement(
              RequireStage,
              { stage: "team" },
              real("connections", React.createElement(ConnectionsPage)),
            ),
          }),
          React.createElement(Route, { path: "/runs/:runId", element: page("run", "team") }),
          React.createElement(Route, { path: "/run-surfaces/:surfaceId", element: page("console", "team") }),
          React.createElement(Route, { path: "/dashboard", element: page("dashboard", "team") }),
          React.createElement(Route, { path: "/setup", element: page("setup", "team") }),
          React.createElement(Route, {
            path: "/admin",
            element: React.createElement(RequireStaff, null,
              realAdmin ? React.createElement(React.Fragment, null, React.createElement(AdminPage), React.createElement(Where, { page: "admin" }))
                : React.createElement(Where, { page: "admin" })),
          }),
          React.createElement(Route, { path: "/", element: real("front", React.createElement(Landing)) }),
        ),
      ),
    ),
  ));
  if (during) await during(window);
  if (signInAs) {
    await act(async () => {
      client.setQueryData(["session"], signInAs);
      // The query cache tells its observers on a later tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  for (const to of then) await act(async () => go(to));
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
    { saved: "/connections?user_code=ABCD-EFGH-IJKL&return_to=setup" },
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
    { saved: "/connections?user_code=ABCD-EFGH-IJKL" },
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

const signedOut = (): Session => ({ ...session("student", { team: true }), user: null, cohort: null, team: null });

test("a run or console opened while signed out is where sign-in returns", async () => {
  for (const [entry, page] of [
    ["/runs/run_demo_p1", "run"],
    ["/run-surfaces/surface_0a1b2c3d4e", "console"],
    ["/runs/run_demo_p1/", "run"],
  ] as const) {
    let savedAtSignIn: string | null = null;
    const { settled, keptReturn } = await navigate(signedOut(), entry, {
      during: async () => { savedAtSignIn = pendingReturn(); },
      signInAs: session("student", { team: true }),
    });
    assert.equal(savedAtSignIn, entry, `${entry} is saved on the way to /signin`);
    assert.equal(settled, `${page} ${entry}`);
    assert.equal(keptReturn, null, "the return is spent on arrival");
  }
});

test("a run link that needs onboarding first is dropped, not replayed later", async () => {
  // A run belongs to a team. Whoever has none goes to the step they owe or,
  // for staff, the console, and the link does not resurface from `/`.
  for (const [who, expected] of [
    [session("student"), "connect /connect"],
    [session("student", { cohort: false }), "join /join"],
    [session("staff", { cohort: false }), "admin /admin"],
  ] as const) {
    const signedIn = await navigate(signedOut(), "/runs/run_demo_p1", { signInAs: who });
    assert.equal(signedIn.settled, expected);
    assert.equal(signedIn.keptReturn, null);
    const home = await navigate(who, "/signin", { saved: "/runs/run_demo_p1", then: ["/"] });
    assert.equal(home.settled, "front /");
  }
});

test("ordinary sign-in and the front page are unchanged", async () => {
  // Signed out, a team page saves nothing to return to, and replaces a link
  // an earlier signed-out visit saved and then left.
  for (const saved of ["", "/runs/run_demo_p1", "/connections?user_code=ABCD-EFGH-IJKL"]) {
    const fromDashboard = await navigate(signedOut(), "/dashboard", {
      saved,
      signInAs: session("student", { team: true }),
    });
    assert.equal(fromDashboard.settled, "dashboard /dashboard", `after ${saved || "nothing"}`);
    assert.equal(fromDashboard.keptReturn, null);
  }
  assert.equal(
    (await navigate(signedOut(), "/signin", { signInAs: session("student", { team: true }) })).settled,
    "dashboard /dashboard",
  );
  assert.equal((await navigate(signedOut(), "/")).settled, "front /");
  assert.equal((await navigate(session("student", { team: true }), "/")).settled, "front /");
});

test("an approval left unanswered no longer pulls `/` and /signin back to it", async () => {
  for (const link of ["/connections?user_code=ABCD-EFGH-IJKL", "/connections#discord=state-token"]) {
    const arrived = await navigate(session("student", { team: true }), "/signin", { saved: link });
    // The router keeps the fragment. The page reads it from window.location,
    // which this memory router does not drive, so the Discord request itself
    // is checked in the browser.
    assert.equal(arrived.settled, `connections ${link}`);
    assert.equal(arrived.keptReturn, null);
    const home = await navigate(session("student", { team: true }), "/signin", { saved: link, then: ["/"] });
    assert.equal(home.settled, "front /");
    const again = await navigate(session("student", { team: true }), "/signin", { saved: link, then: ["/", "/signin"] });
    assert.equal(again.settled, "dashboard /dashboard");
  }
});

test("an expired device code shows the server's reason and leaves home reachable", async () => {
  const reason = "The device code is invalid, expired, or already used.";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: "link_expired", message: reason } }), {
      status: 410,
      headers: { "content-type": "application/json" },
    });
  try {
    let alert = "";
    const { settled, keptReturn } = await navigate(session("student", { team: true }), "/signin", {
      saved: "/connections?user_code=ABCD-EFGH-IJKL",
      during: async (window) => {
        const form = window.document.querySelector("form");
        assert.ok(form, "the approval form is on the page");
        await act(async () => {
          form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        alert = window.document.querySelector('[role="alert"]')?.textContent ?? "";
      },
      then: ["/"],
    });
    assert.equal(alert, reason);
    assert.equal(settled, "front /");
    assert.equal(keptReturn, null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
