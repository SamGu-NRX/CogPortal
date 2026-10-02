// First, so React DOM sees a document when it loads (see the fixture).
import "./fixtures/dom-before-react.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router";
import { Window } from "happy-dom";
import { useRouteFocusAndTitle } from "../src/lib/route-focus.ts";

/**
 * A page change has to be announced: the document title names the page, and
 * focus moves to its heading after a navigation unless the page put focus
 * somewhere itself. The first load leaves focus alone.
 */

const h = React.createElement;

function Layout() {
  const header = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  useRouteFocusAndTitle(main, header);
  return h(React.Fragment, null,
    h("header", { ref: header },
      h(Link, { to: "/" }, "Runs"),
      h(Link, { to: "/team" }, "Team"),
      h(Link, { to: "/console" }, "Console"),
    ),
    h("main", { ref: main }, h(Outlet)),
  );
}

/** The heading arrives with the data, a task after the page mounts. */
function LatePage() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setLoaded(true), 0); return () => clearTimeout(timer); }, []);
  return loaded ? h("h1", null, "Demo  Team") : h("p", null, "Loading…");
}

/** Like a run that keeps focus on its console after starting. */
function ConsolePage() {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus(); }, []);
  return h(React.Fragment, null, h("h1", null, "Run console"), h("button", { ref: button, type: "button" }, "Publish result"));
}

async function mount(t: TestContext, strict = false) {
  const window = new Window({ url: "https://portal.example/" });
  const globals = {
    window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const wrap = (node: React.ReactNode) => (strict ? h(React.StrictMode, null, node) : node);
  await act(async () => root.render(wrap(
    h(MemoryRouter, { initialEntries: ["/"] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { index: true, element: h("h1", null, "Runs") }),
          h(Route, { path: "team", element: h(LatePage) }),
          h(Route, { path: "console", element: h(ConsolePage) }),
        ),
      ),
    ),
  )));
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  const follow = async (name: string) => {
    const link = [...container.querySelectorAll("header a")].find((a) => a.textContent === name) as HTMLAnchorElement;
    link.focus();
    await act(async () => { link.click(); });
    await settle();
  };
  return { window, container, settle, follow, root: () => window.document.querySelector("main")! };
}

test("the first load names the page and leaves focus alone", async (t) => {
  const { window, settle } = await mount(t);
  await settle();
  assert.equal(window.document.title, "Runs · Cog*Portal");
  assert.equal(window.document.activeElement, window.document.body);
});

test("React's development double-run of effects does not count as a navigation", async (t) => {
  // StrictMode runs each effect twice on mount; the first load's heading
  // took focus on 5187 before this was pinned.
  const { window, settle } = await mount(t, true);
  await settle();
  assert.equal(window.document.title, "Runs · Cog*Portal");
  assert.equal(window.document.activeElement, window.document.body);
});

test("a header link moves focus to the new page's heading, even one that renders late", async (t) => {
  const { window, follow } = await mount(t);
  await follow("Team");
  const heading = window.document.querySelector("main h1");
  assert.ok(heading, "the late heading rendered");
  assert.equal(window.document.activeElement, heading, "focus is on the page heading, not the header link");
  assert.equal(heading.getAttribute("tabindex"), "-1");
  assert.equal(window.document.title, "Demo Team · Cog*Portal", "whitespace in the heading collapses");
});

test("a page that places focus itself keeps it", async (t) => {
  const { window, follow } = await mount(t);
  await follow("Console");
  assert.equal(window.document.activeElement?.textContent, "Publish result");
  assert.equal(window.document.title, "Run console · Cog*Portal");
});

test("going back to a page names it again", async (t) => {
  const { window, follow } = await mount(t);
  await follow("Team");
  await follow("Runs");
  assert.equal(window.document.title, "Runs · Cog*Portal");
  assert.equal(window.document.activeElement?.textContent, "Runs");
  assert.equal(window.document.activeElement?.tagName, "H1");
});

test("after the heading takes focus once, a later change to the page never pulls focus back", async (t) => {
  const { window, container, settle, follow, root } = await mount(t);
  await follow("Team");
  assert.equal(window.document.activeElement?.tagName, "H1");
  // The user moves to a header control, then the page refetches.
  const link = [...container.querySelectorAll("header a")].find((a) => a.textContent === "Runs") as HTMLAnchorElement;
  link.focus();
  await act(async () => { root().append(window.document.createElement("p")); });
  await settle();
  assert.equal(window.document.activeElement, link, "the header control keeps focus");
});

test("a key pressed before a late heading renders cancels the move", async (t) => {
  const { window, container, settle } = await mount(t);
  const link = [...container.querySelectorAll("header a")].find((a) => a.textContent === "Team") as HTMLAnchorElement;
  link.focus();
  await act(async () => { link.click(); });
  // The heading is still loading; the user is already moving on.
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  await settle();
  assert.ok(window.document.querySelector("main h1"), "the heading rendered");
  assert.equal(window.document.activeElement, link, "focus stayed where the user had it");
  assert.equal(window.document.title, "Demo Team · Cog*Portal", "the title still follows");
});
