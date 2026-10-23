import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Session } from "@cogworks/contracts/schema";

const session: Session = {
  user: { login: "fixture-device", name: "Fixture device", avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
  cohort: { slug: "bwsi", name: "BWSI" },
  team: { id: "team_1", name: "Team One", description: null, repo: null },
  auth: {
    githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
    appSlug: null, templateRepo: null, executionProvider: "fixture",
  },
};

async function mount(t: TestContext, entry: string) {
  const window = new Window({ url: `https://portal.example${entry}` });
  const approvals: unknown[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init: { method?: string; body?: string } = {}) => {
      const path = new URL(input, "https://portal.example").pathname;
      if (path === "/api/v1/connections") return Response.json({ github: null, discord: null, cliDevices: [] });
      if (path === "/api/v1/cli/device/approve") {
        approvals.push(JSON.parse(init.body ?? "null"));
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${path}`);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  });
  client.setQueryData(["connections"], { github: null, discord: null, cliDevices: [] });
  client.setQueryData(["session"], session);
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
  const { ConnectionsPage } = await import("../src/routes/ConnectionsPage.tsx");
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(ConnectionsPage))),
  ));
  const field = () => container.querySelector<HTMLInputElement>("#device-name");
  const approve = async () => {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Approve device");
    assert.ok(button, "no Approve device button");
    await act(async () => button.click());
    for (let index = 0; index < 10; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  return { field, approve, approvals };
}

test("the approval form ignores a hostname in the URL and approves the generic default", async (t) => {
  const { field, approve, approvals } = await mount(
    t, "/connections?user_code=ABCD-EFGH-IJKL&return_to=setup&device_name=PRIVATE-HOSTNAME-SENTINEL",
  );
  assert.equal(field()?.value, "CogWorks CLI");
  await approve();
  assert.deepEqual(approvals, [{ userCode: "ABCD-EFGH-IJKL", deviceName: "CogWorks CLI" }]);
});

test("an older CLI link starts the approval form with the generic default", async (t) => {
  const { field } = await mount(t, "/connections?user_code=ABCD-EFGH-IJKL&return_to=setup");
  assert.equal(field()?.value, "CogWorks CLI");
});
