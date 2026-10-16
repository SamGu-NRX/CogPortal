import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Session } from "@cogworks/contracts/schema";
import { Landing } from "../src/routes/Landing.tsx";
import { SignInPage } from "../src/routes/SignInPage.tsx";
import { LeaderboardPage } from "../src/routes/LeaderboardPage.tsx";
import { ENTRY_STATES } from "./fixtures/entry-states.ts";

/**
 * The public entry, as a signed-out student meets it.
 *
 * The entry's job is to point at the student's actual next step, so these
 * tests pin the three things that can quietly rot: the CTA promising a
 * sign-in the deployment does not offer, a link to a route the signed-out
 * visitor cannot actually use, and the steps after sign-in drifting away
 * from the names the pages themselves use. Sessions come from the frozen
 * fixture states (fixtures/entry-states.ts), parsed against the shipped
 * contracts at load.
 */

/** Mounts the real Landing between the real /signin and /leaderboard (the
 *  two places its links lead) and reports the links and text it rendered.
 *  Same global-install idiom as staff-landing.test.ts. */
async function renderEntry(value: Session, entry = "/") {
  const window = new Window({ url: `https://portal.example${entry}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, val] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: val });
  }

  // Seeded and never stale, so no read reaches for the network.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["session"], value);

  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations used by React DOM.
  const root = createRoot(container as unknown as Element);

  let go: (to: string) => void = () => {};
  let pathname = entry;
  function Where() {
    const location = useLocation();
    go = useNavigate();
    pathname = location.pathname;
    return null;
  }

  await act(async () =>
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: [entry] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/",
              element: React.createElement(Fragment, null, React.createElement(Landing), React.createElement(Where)),
            }),
            React.createElement(Route, {
              path: "/signin",
              element: React.createElement(Fragment, null, React.createElement(SignInPage), React.createElement(Where)),
            }),
            React.createElement(Route, {
              path: "/leaderboard",
              element: React.createElement(Fragment, null, React.createElement(LeaderboardPage), React.createElement(Where)),
            }),
            React.createElement(Route, { path: "/join", element: React.createElement(Where) }),
            React.createElement(Route, { path: "/connect", element: React.createElement(Where) }),
            React.createElement(Route, { path: "/dashboard", element: React.createElement(Where) }),
            React.createElement(Route, { path: "/setup", element: React.createElement(Where) }),
            React.createElement(Route, { path: "*", element: React.createElement("p", null, "NOT_FOUND") }),
          ),
        ),
      ),
    ),
  );

  const text = container.textContent ?? "";
  const links = [...container.querySelectorAll("a")].map((node) => [
    (node.textContent ?? "").trim(),
    node.getAttribute("href"),
  ]);
  // The specimen's readings live in the svg's aria-label, an attribute, not
  // in textContent.
  const svgLabel = container.querySelector('svg[role="img"]')?.getAttribute("aria-label") ?? "";

  const cleanup = async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };

  return {
    text,
    links,
    svgLabel,
    /** Navigate in-app to a link target and report where the router sat. */
    visit: async (to: string) => {
      await act(async () => go(to));
      return pathname;
    },
    cleanup,
  };
}

test("the signed-out entry points at sign-in and names what follows", async () => {
  const view = await renderEntry(ENTRY_STATES.SIGNED_OUT);
  try {
    // The primary CTA is the actual next step, and the quiet one is the
    // other public page.
    assert.deepEqual(view.links.find(([label]) => label === "Sign in with GitHub"), [
      "Sign in with GitHub",
      "/signin",
    ]);
    assert.deepEqual(view.links.find(([label]) => label === "See this year's results"), [
      "See this year's results",
      "/leaderboard",
    ]);
    // The fork link rides the anonymous session's templateRepo, so it is
    // present and points at the fixture template.
    assert.ok(
      view.links.some(([, href]) => href === "https://github.com/cogworks-fixtures/capstone-template"),
      "the template fork link renders for a signed-out visitor",
    );
    // The steps after sign-in, in the pages' own words (JoinPage, ConnectPage,
    // SetupPage headings).
    assert.match(view.text, /Signing in is the first of four steps/);
    assert.match(view.text, /join the cohort/);
    assert.match(view.text, /join or start your team/);
    assert.match(view.text, /set up your machine/);
    // /setup is team-gated (RequireStage stage="team"), so the entry must
    // not link it: signed out it would save a return and bounce through
    // /signin. The sentence carries the information instead.
    assert.ok(
      view.links.every(([, href]) => href !== "/setup"),
      "the entry never links the team-gated setup page",
    );
  } finally {
    await view.cleanup();
  }
});

test("the entry never promises a GitHub sign-in the deployment cannot offer", async () => {
  const view = await renderEntry(ENTRY_STATES.SIGNED_OUT_GITHUB_UNCONFIGURED);
  try {
    // Same flag SignInPage disables its button on; until the session read
    // says otherwise, the label every deployment can honor is "Sign in".
    assert.deepEqual(view.links.find(([label]) => label === "Sign in"), ["Sign in", "/signin"]);
    assert.ok(!view.text.includes("Sign in with GitHub"), "no GitHub promise anywhere on the page");
  } finally {
    await view.cleanup();
  }
});

test("a signed-in student gets their stage, not the signed-out ladder", async () => {
  for (const [state, label, href] of [
    [ENTRY_STATES.PENDING_JOIN, "Continue setting up", "/join"],
    [ENTRY_STATES.PENDING_CONNECT, "Continue setting up", "/connect"],
    [ENTRY_STATES.READY, "Open your runs", "/dashboard"],
  ] as const) {
    const view = await renderEntry(state);
    try {
      assert.deepEqual(view.links.find(([l]) => l === label), [label, href]);
      assert.ok(
        !view.text.includes("Signing in is the first of four steps"),
        "the signed-out ladder sentence is gone once signed in",
      );
    } finally {
      await view.cleanup();
    }
  }
});

test("every internal link on the signed-out entry lands on a real route", async () => {
  const view = await renderEntry(ENTRY_STATES.SIGNED_OUT);
  try {
    const internal = view.links
      .map(([, href]) => href ?? "")
      .filter((href) => href.startsWith("/"));
    assert.ok(internal.includes("/signin"), "sign-in is among the links");
    assert.ok(internal.includes("/leaderboard"), "the leaderboard is among the links");
    for (const href of [...new Set(internal)]) {
      const at = await view.visit(href);
      assert.notEqual(at, "NOT_FOUND", `${href} must be a route the app serves`);
      if (href === "/signin") assert.equal(at, "/signin");
      await view.visit("/");
    }
  } finally {
    await view.cleanup();
  }
});

test("the specimen stays an example: the numbers it shows are the gallery fixture's", async () => {
  const view = await renderEntry(ENTRY_STATES.SIGNED_OUT);
  try {
    // Labeled as an example because nothing on it was measured.
    assert.match(view.text, /Example/);
    // The trace is the gallery's "A knee" fixture (GalleryPage SWEEPS), and
    // the accessible description carries the same readings.
    const figure = view.svgLabel;
    assert.ok(figure.startsWith("Example trace:"), "the specimen svg is described");
    assert.ok(/0\.90 at 5 songs/.test(figure), "the aria label names the 0.90 reading");
    assert.ok(/0\.85 at 20/.test(figure), "the aria label names the 0.85 reading");
    assert.ok(/0\.21 at 80/.test(figure), "the aria label names the 0.21 reading");
  } finally {
    await view.cleanup();
  }
});
