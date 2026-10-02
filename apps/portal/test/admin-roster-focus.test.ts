// First, so React DOM sees a document when it loads (see the fixture).
import "./fixtures/dom-before-react.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { AdminOverview, AdminTeamSummary } from "@cogworks/contracts/schema";
import { AdminPage } from "../src/routes/AdminPage.tsx";

/**
 * Roster edits on the admin page replace the control that made them: an
 * assigned student's row leaves the list, and a cleared login field disables
 * its own submit button. Either one used to drop keyboard focus to the page.
 */

function team(id: string, name: string): AdminTeamSummary {
  return {
    id, name, provenance: "live", repoFullName: `demo/${id}`,
    members: [{ login: `${id}-admin`, name: null, role: "admin" }], tas: [],
    practiceUsed: 0, officialUsed: 0, refundsGiven: 0, published: null,
  };
}

async function mount(t: TestContext, unassigned: string[], addGate: Promise<void> = Promise.resolve()) {
  const window = new Window({ url: "https://portal.example/admin" });
  let overview: AdminOverview = {
    scope: "owner",
    cohort: { slug: "test", name: "Test cohort", joinCode: "CODE", active: true },
    teams: [team("team_a", "Team A"), team("team_b", "Team B")],
    unassigned: unassigned.map((login) => ({ login, name: null, joinedAt: null })),
  };
  let staff = { entries: [] as { login: string; name: null; grantedBy: string; grantedAt: number }[], owners: ["owner"] };
  const globals = {
    window, document: window.document, navigator: window.navigator,
    sessionStorage: window.sessionStorage, HTMLElement: window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init: { method?: string; body?: string } = {}) => {
      const body = JSON.parse(init.body ?? "{}") as { login?: string };
      const added = /^\/api\/admin\/teams\/([^/]+)\/members$/.exec(input);
      if (added && init.method === "POST") {
        await addGate;
        const target = overview.teams.find((entry) => entry.id === added[1])!;
        const next = { ...target, members: [...target.members, { login: body.login!, name: null, role: "write" as const }] };
        overview = {
          ...overview,
          teams: overview.teams.map((entry) => (entry.id === next.id ? next : entry)),
          unassigned: overview.unassigned.filter((student) => student.login !== body.login),
        };
        return Response.json(next);
      }
      if (input === "/api/admin/staff" && init.method === "POST") {
        staff = { ...staff, entries: [...staff.entries, { login: body.login!, name: null, grantedBy: "owner", grantedAt: 1 }] };
        return Response.json(staff);
      }
      if (input === "/api/admin/overview") return Response.json(overview);
      if (input === "/api/admin/staff") return Response.json(staff);
      if (input.startsWith("/api/leaderboard")) return Response.json([]);
      throw new Error(`unexpected request ${init.method ?? "GET"} ${input}`);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  client.setQueryData(["admin", "overview"], overview);
  client.setQueryData(["admin", "staff"], staff);
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
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(AdminPage))));
  // Lets the request, the invalidation's refetch and the re-render land.
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  return { window, container, settle };
}


/** Identity, reported by tag and text: assert.equal on two DOM nodes formats
 *  both whole graphs on failure, which can stall the runner. */
function assertFocused(actual: Element | null | undefined, expected: Element | null | undefined, message: string) {
  const describe = (node: Element | null | undefined) => (node ? `${node.tagName} "${node.textContent?.trim().slice(0, 40)}"` : String(node));
  assert.ok(actual === expected, `${message}: focus is on ${describe(actual)}, expected ${describe(expected)}`);
}

test("assigning a student moves focus to the row that takes its place, then to the line saying who was added", async (t) => {
  const { window, container, settle } = await mount(t, ["first", "second", "third"]);
  const selectFor = (login: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="Assign ${login} to a team"]`);
  const assign = async (login: string, teamName: string) => {
    const select = selectFor(login);
    assert.ok(select);
    select.focus();
    const option = [...select.options].find((entry) => entry.textContent === teamName);
    assert.ok(option);
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, option.value);
    await act(async () => { select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await settle();
    assert.equal(select.isConnected, false, "the assigned student leaves the list");
  };

  // From the middle: the next student moves up into its place.
  await assign("second", "Team A");
  assertFocused(window.document.activeElement, selectFor("third"), "after the middle row");
  // From the bottom: the row above is the nearest one left.
  await assign("third", "Team B");
  assertFocused(window.document.activeElement, selectFor("first"), "after the last row");

  await assign("first", "Team B");
  const added = window.document.activeElement;
  assert.equal(added?.getAttribute("role"), "status");
  assert.equal(added?.textContent, "Added first to Team B.");
});

test("a select stays focusable while its assignment is pending", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { window, container, settle } = await mount(t, ["only"], gate);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Assign only to a team"]');
  assert.ok(select);
  try {
    select.focus();
    const option = [...select.options].find((entry) => entry.textContent === "Team A");
    assert.ok(option);
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, option.value);
    await act(async () => {
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      // The mutation's pending state reaches the component on a zero-delay timer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // A disabled select would drop focus in a browser before the row leaves.
    assert.equal(select.disabled, false);
    assert.equal(select.getAttribute("aria-disabled"), "true");
    assertFocused(window.document.activeElement, select, "while pending");
  } finally {
    // A failed assertion must not leave the request waiting forever.
    release();
    await settle();
  }
  assert.equal(window.document.activeElement?.getAttribute("role"), "status");
});

test("a login form keeps focus in its field after the login is added", async (t) => {
  const { window, container, settle } = await mount(t, []);
  const field = container.querySelector<HTMLInputElement>("#add-staff");
  assert.ok(field);
  field.focus();
  await act(async () => {
    // Through the prototype setter, as typing does; assigning .value directly
    // updates React's value tracker and the change is never seen.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "new-staff");
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const submit = field.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.ok(submit);
  assert.equal(submit.disabled, false);
  submit.focus();
  await act(async () => submit.click());
  await settle();
  assert.match(container.textContent ?? "", /new-staff/);
  assert.equal(field.value, "");
  assert.equal(submit.disabled, true, "an empty field still can't be submitted");
  assertFocused(window.document.activeElement, field, "focus");
});
