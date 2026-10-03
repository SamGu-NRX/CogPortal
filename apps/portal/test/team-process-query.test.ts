import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { useTeamProcess } from "../src/lib/queries.ts";

const SIGNALS = {
  historyQuality: "empty",
  historyWindow: { commits: 0, truncated: false },
  weekLabel: null,
  stageFootprint: {},
  firstLight: { firstScoredAt: null, scoredRunCount: 0 },
  boundaryChurn: [],
  ownershipBreadth: {},
  findingSentences: [],
  computedAt: 1_780_000_000_000,
};

function Reader() {
  const process = useTeamProcess();
  return React.createElement("p", null, process.data ? "read" : "waiting");
}

test("returning to the team page asks for the signals again", async (t) => {
  // The worker reads runs on every request, so a cached body in the browser is
  // the only thing left that could keep a new first scored run off the page.
  const window = new Window({ url: "https://portal.example/team" });
  let requests = 0;
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string) => {
      assert.equal(input, "/api/v1/team/process");
      requests += 1;
      return Response.json(SIGNALS);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  const visit = async () => {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(Reader)),
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(container.textContent, "read");
  };

  await visit();
  await act(async () => root.render(React.createElement(QueryClientProvider, { client })));
  await visit();
  assert.equal(requests, 2);
});
