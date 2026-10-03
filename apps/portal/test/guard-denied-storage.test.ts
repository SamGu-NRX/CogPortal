import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";

/**
 * The stage guard writes the dropped-link notice just before it redirects a
 * student who still owes a team. A browser that denies session storage used
 * to throw there, so the student got an error instead of the redirect.
 */

const STUDENT_WITHOUT_TEAM = {
  user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
  cohort: { slug: "bwsi", name: "BWSI" },
  team: null,
  auth: {
    githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
    appSlug: null, templateRepo: null, executionProvider: "fixture",
  },
};

async function mountGuard(t: TestContext, entry: string) {
  const window = new Window({ url: `https://portal.example${entry}` });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => Response.json(STUDENT_WITHOUT_TEAM),
  };
  const previous = new Map(
    [...Object.keys(globals), "sessionStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // The browser refuses on the property read itself.
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity } },
  });
  client.setQueryData(["session"], STUDENT_WITHOUT_TEAM);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  // Imported after the globals exist: Motion decides at module load whether
  // it is running in a browser.
  const { RequireStage } = await import("../src/App.tsx");
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [entry] },
        React.createElement(Routes, null,
          React.createElement(Route, {
            path: "/connections",
            element: React.createElement(RequireStage, { stage: "team" }, React.createElement("p", null, "connections page")),
          }),
          React.createElement(Route, { path: "/connect", element: React.createElement("p", null, "connect page") }),
        ),
      ),
    ),
  ));
  return { container };
}

for (const entry of ["/connections?user_code=ABCD-EFGH-IJKL", "/connections#discord=state-token"]) {
  test(`denied storage still sends a student who owes a team from ${entry} to /connect`, async (t) => {
    const { container } = await mountGuard(t, entry);
    assert.equal(container.textContent, "connect page");
  });
}
