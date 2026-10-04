import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { ConnectionSummary, Session } from "@cogworks/contracts/schema";

/**
 * Connections replaces the control that made a change with the change's
 * result: an approved device's form becomes a line saying so, and revoking
 * the last device swaps the list for the link command. Either used to drop
 * keyboard focus to the page.
 */

const DEVICE = { id: "device_1", name: "Lab laptop", createdAt: 1_750_000_000_000, lastUsedAt: null };

/** A signed-in student on a team, in the shape /api/session returns. */
const session = (login: string): Session => ({
  user: { login, name: login, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
  cohort: { slug: "bwsi", name: "BWSI" },
  team: { id: "team_1", name: "Team One", description: null, repo: null },
  auth: {
    githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
    appSlug: null, templateRepo: null, executionProvider: "fixture",
  },
});

async function mount(t: TestContext, entry: string, initial: ConnectionSummary, signedIn: Session = session("ada")) {
  const window = new Window({ url: `https://portal.example${entry}` });
  let summary = initial;
  const requests: string[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init: { method?: string; body?: string } = {}) => {
      const path = new URL(input, "https://portal.example").pathname;
      requests.push(`${init.method ?? "GET"} ${path}`);
      if (path === "/api/v1/connections") return Response.json(summary);
      if (path === "/api/v1/cli/device/approve") return Response.json({ ok: true });
      if (path === "/api/v1/cli/devices" && init.method === "DELETE") {
        const { deviceId } = JSON.parse(init.body ?? "{}") as { deviceId: string };
        summary = { ...summary, cliDevices: summary.cliDevices.filter((device) => device.id !== deviceId) };
        return Response.json(summary);
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${path}`);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // Infinity for both, so no five-minute collection timer holds the process.
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  });
  client.setQueryData(["connections"], summary);
  // The page settles an approval only for the account on screen, so a test
  // that approves needs one.
  client.setQueryData(["session"], signedIn);
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
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  return { window, container, requests, settle };
}

const buttonNamed = (container: HTMLElement, name: RegExp) => {
  const found = [...container.querySelectorAll("button")].find((button) => name.test(button.textContent?.trim() ?? ""));
  assert.ok(found, `no button matching ${name}`);
  return found;
};

/** Identity, reported by tag and text: assert.equal on two DOM nodes formats
 *  both whole graphs on failure, which can stall the runner. */
function assertFocused(actual: Element | null | undefined, expected: Element | null | undefined, message: string) {
  const describe = (node: Element | null | undefined) => (node ? `${node.tagName} "${node.textContent?.trim().slice(0, 40)}"` : String(node));
  assert.ok(actual === expected, `${message}: focus is on ${describe(actual)}, expected ${describe(expected)}`);
}

test("approving a device moves focus to the line saying it was approved", async (t) => {
  const { window, container, requests, settle } = await mount(
    t, "/connections?user_code=ABCD-EFGH", { github: null, discord: null, cliDevices: [] },
  );
  const approve = buttonNamed(container, /^Approve device$/);
  approve.focus();
  await act(async () => approve.click());
  await settle();

  assert.ok(requests.includes("POST /api/v1/cli/device/approve"));
  assert.equal(approve.isConnected, false, "the form goes once the device is approved");
  const outcome = container.querySelector("[data-request-outcome]");
  assert.match(outcome?.textContent ?? "", /Device approved/);
  assertFocused(window.document.activeElement, outcome, "after approving");
});

test("revoking the last device moves focus to the tool's heading, not the page", async (t) => {
  const { window, container, settle } = await mount(
    t, "/connections", { github: null, discord: null, cliDevices: [DEVICE] },
  );
  const revoke = buttonNamed(container, /^Revoke/);
  revoke.focus();
  await act(async () => revoke.click());
  const confirm = buttonNamed(container, /^Confirm, it stops reporting/);
  confirm.focus();
  await act(async () => confirm.click());
  await settle();

  assert.match(container.textContent ?? "", /No devices linked/);
  const heading = [...container.querySelectorAll("h2")].find((node) => node.textContent === "CogWorks tool");
  assertFocused(window.document.activeElement, heading, "after revoking");
});
