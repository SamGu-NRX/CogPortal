import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { Window } from "happy-dom";
import { useChangeTeamRepo, useDashboard } from "../src/lib/queries.ts";

/**
 * QA on v45: a team changed its repository on Team, the save succeeded, and
 * Runs opened next still described the previous repository until a reload.
 * Every answer about "the connected repository" was cached under the old one,
 * and invalidation only marks it stale, so it painted until the refetch
 * landed: the old name, and a promotion the server now refuses.
 */
test("Runs opened after a repository change never shows the previous repository", async (t) => {
  const window = new Window({ url: "https://portal.example/team" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, React, IS_REACT_ACT_ENVIRONMENT: true,
    // The save answers; every read after it is held in flight, as a slow
    // Worker would hold it, so whatever paints comes from the cache.
    fetch: async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "/api/team/repository") {
        return new Response(JSON.stringify({
          id: "team_1", name: "Team One", description: null, provenance: "live",
          repo: { owner: "demo", name: "language", fullName: "demo/language", url: "https://github.com/demo/language", defaultBranch: "main" },
          members: [], tas: [], isAdmin: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Promise<Response>(() => {});
    },
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
  // What Runs, a run page and the local reports read before the save.
  const previous = { fullName: "demo/week2_capstone" };
  client.setQueryData(["dashboard", "language-search"], { team: { repo: previous }, activeRun: null });
  client.setQueryData(["run", "run_old"], { id: "run_old", sourceRefusal: null });
  client.setQueryData(["local-reports", "language-search"], [{ repositoryFullName: previous.fullName }]);

  let save: () => Promise<unknown> = async () => undefined;
  function Team() {
    const change = useChangeTeamRepo();
    save = () => change.mutateAsync("demo/language");
    return React.createElement(Link, { to: "/dashboard" }, "Runs");
  }
  function Runs() {
    const dashboard = useDashboard("language-search");
    return React.createElement("p", null, dashboard.data ? `connected ${dashboard.data.team.repo?.fullName}` : "loading");
  }

  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses, with separate TS interfaces.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: ["/team"] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/team", element: React.createElement(Team) }),
          React.createElement(Route, { path: "/dashboard", element: React.createElement(Runs) }))))));

  await act(async () => { await save(); });
  await act(async () => { container.querySelector("a")!.click(); });

  assert.equal(container.textContent, "loading");
  // A run page or the local reports opened next wait for their new answer too.
  assert.equal(client.getQueryData(["run", "run_old"]), undefined);
  assert.equal(client.getQueryData(["local-reports", "language-search"]), undefined);
});
