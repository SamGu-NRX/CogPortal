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
    practiceUsed: 0, officialUsed: 0, hostedRuns: 0, refundsGiven: 0, published: null,
    firstLight: null, lastHostedRun: null,
  };
}

async function mount(t: TestContext, unassigned: string[], addGate: Promise<void> = Promise.resolve()) {
  const requests: string[] = [];
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
      requests.push(`${init.method ?? "GET"} ${input}`);
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
  // Mutations too: a finished one otherwise starts TanStack's 5-minute
  // garbage-collection timer, which keeps this process alive after the tests.
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  });
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
  return { window, container, settle, requests, client };
}

/** Picks a team the way the browser does, keyboard or pointer: the select's
 *  value changes and it fires `change`. Nothing else. */
async function choose(window: Window, select: HTMLSelectElement, teamName: string) {
  select.focus();
  const option = [...select.options].find((entry) => entry.textContent === teamName);
  assert.ok(option, `no option ${teamName}`);
  // The native setter, so React's value tracker sees the change.
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, option.value);
  await act(async () => { select.dispatchEvent(new window.Event("change", { bubbles: true })); });
}

function addButtonFor(select: HTMLSelectElement): HTMLButtonElement {
  const button = select.closest("li")?.querySelector<HTMLButtonElement>("button");
  assert.ok(button, "the row's Add button");
  return button;
}


/** Identity, reported by tag and text: assert.equal on two DOM nodes formats
 *  both whole graphs on failure, which can stall the runner. */
function assertFocused(actual: Element | null | undefined, expected: Element | null | undefined, message: string) {
  const describe = (node: Element | null | undefined) => (node ? `${node.tagName} "${node.textContent?.trim().slice(0, 40)}"` : String(node));
  assert.ok(actual === expected, `${message}: focus is on ${describe(actual)}, expected ${describe(expected)}`);
}

/** Drives React task by task until `check` holds, and fails by name after
 *  a bounded number of tasks rather than hanging. */
async function waitFor(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("choosing a team, by keyboard or pointer, assigns nobody until Add is pressed", async (t) => {
  const { window, container, settle, requests } = await mount(t, ["browsing"]);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Assign browsing to a team"]');
  assert.ok(select);
  const button = addButtonFor(select);
  assert.equal(button.disabled, true, "nothing to add before a team is chosen");
  // A typed letter or an arrow key moves a select through its options and
  // fires change at each one; browsing past Team A to Team B is two changes.
  await choose(window, select, "Team A");
  await choose(window, select, "Team B");
  await settle();
  assert.deepEqual(requests.filter((line) => line.startsWith("POST")), [], "a change alone sends nothing");
  assert.equal(select.isConnected, true);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-label"), "Add browsing to Team B");

  await act(async () => { button.click(); });
  await settle();
  assert.deepEqual(requests.filter((line) => line.startsWith("POST")), ["POST /api/admin/teams/team_b/members"]);
  assert.equal(select.isConnected, false);
});

test("Enter in the select assigns nobody, because the row has no form to submit", async (t) => {
  const { window, container, settle, requests } = await mount(t, ["typing"]);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Assign typing to a team"]');
  assert.ok(select);
  // Chromium submits a form on Enter in a select; a type-ahead to "T" then
  // Enter assigned Team A before this change.
  assert.equal(select.closest("form"), null);
  await choose(window, select, "Team A");
  await act(async () => {
    select.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
  assert.deepEqual(requests.filter((line) => line.startsWith("POST")), []);
  assert.equal(select.isConnected, true);
});

test("assigning a student moves focus to the row that takes its place, then to the line saying who was added", async (t) => {
  const { window, container, settle } = await mount(t, ["first", "second", "third"]);
  const selectFor = (login: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="Assign ${login} to a team"]`);
  const assign = async (login: string, teamName: string) => {
    const select = selectFor(login);
    assert.ok(select);
    await choose(window, select, teamName);
    const button = addButtonFor(select);
    button.focus();
    await act(async () => { button.click(); });
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

test("the row stays focusable while its assignment is pending", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { window, container, settle, requests } = await mount(t, ["only"], gate);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Assign only to a team"]');
  assert.ok(select);
  try {
    await choose(window, select, "Team A");
    const button = addButtonFor(select);
    button.focus();
    await act(async () => { button.click(); });
    // The mutation's pending state reaches the component on a later task.
    await waitFor(() => select.getAttribute("aria-disabled") === "true", "the pending assignment");
    // Disabled controls would drop focus in a browser before the row leaves.
    assert.equal(select.disabled, false);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assertFocused(window.document.activeElement, button, "while pending");
    // A second press while pending sends nothing more.
    await act(async () => { button.click(); });
    assert.deepEqual(requests.filter((line) => line.startsWith("POST")), ["POST /api/admin/teams/team_a/members"]);
  } finally {
    // A failed assertion must not leave the request waiting forever.
    release();
    await settle();
  }
  assert.equal(window.document.activeElement?.getAttribute("role"), "status");
  assert.deepEqual(requests.filter((line) => line.startsWith("POST")), ["POST /api/admin/teams/team_a/members"], "still one request after it landed");
});

test("a refetch that drops the chosen team clears the choice and keeps focus off the disabled Add", async (t) => {
  const { window, container, settle, requests, client } = await mount(t, ["waiting"]);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Assign waiting to a team"]');
  assert.ok(select);
  await choose(window, select, "Team B");
  const button = addButtonFor(select);
  button.focus();
  await act(async () => {
    client.setQueryData<AdminOverview>(["admin", "overview"], (current) =>
      current ? { ...current, teams: current.teams.filter((entry) => entry.id !== "team_b") } : current);
  });
  await settle();
  assert.equal(select.value, "", "the field says Choose a team… again, not the first remaining team");
  assert.equal(button.disabled, true);
  assertFocused(window.document.activeElement, select, "focus moved off Add before it was disabled");
  assert.deepEqual(requests.filter((line) => line.startsWith("POST")), []);
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

test("an opened team row leads with its run state", async (t) => {
  const { container, client } = await mount(t, []);
  await act(async () => {
    client.setQueryData<AdminOverview>(["admin", "overview"], (current) => current && {
      ...current,
      teams: current.teams.map((entry) => entry.id === "team_b"
        ? {
            ...entry, hostedRuns: 1,
            lastHostedRun: {
              benchmarkId: "test_vision", benchmarkTitle: "Face recognition", at: Date.now() - 3 * 60 * 60 * 1_000, status: "failed",
              failure: { phase: "contract_check", category: "adapter_missing" },
            },
          }
        : entry),
    });
  });
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
    .find((button) => button.textContent?.includes("Team B"));
  assert.ok(toggle, "Team B's row");
  await act(async () => { toggle.click(); });
  const details = container.querySelector(`#${toggle.getAttribute("aria-controls")}`);
  const headings = [...(details?.querySelectorAll("h3") ?? [])].map((heading) => heading.textContent);
  assert.deepEqual(headings.slice(0, 2), ["Run state", "Members"]);
  const text = details?.textContent ?? "";
  assert.match(text, /Hasn't run end to end from this repository yet\./);
  assert.match(text, /Last hosted run: Face recognition, 3 h ago, failed at Contract check\. Nothing here could be scored \(E-ADAPTER\)\./);
});

// Safari doesn't focus a clicked button, so closing a row by pointer can find
// focus still on a field inside it, and unmounting the details dropped it to
// the body. Happy DOM's click() doesn't move focus either, as in Safari.
test("closing a row while a field inside it has focus puts focus on the row's toggle", async (t) => {
  const { window, container } = await mount(t, []);
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
    .find((button) => button.textContent?.includes("Team B"));
  assert.ok(toggle, "Team B's row");
  await act(async () => { toggle.click(); });
  const field = container.querySelector<HTMLInputElement>(`#${toggle.getAttribute("aria-controls")} input`);
  assert.ok(field, "a field inside the opened row");
  field.focus();
  assertFocused(window.document.activeElement, field, "before closing");
  await act(async () => { toggle.click(); });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assertFocused(window.document.activeElement, toggle, "after closing");
});

// WebKit moves focus off a field to the body at mousedown, before the click,
// so the toggle reads at pointerdown whether focus was inside its row.
test("closing a row by mouse after WebKit has already taken focus off its field puts focus on the toggle", async (t) => {
  const { window, container } = await mount(t, []);
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
    .find((button) => button.textContent?.includes("Team B"));
  assert.ok(toggle, "Team B's row");
  await act(async () => { toggle.click(); });
  const field = container.querySelector<HTMLInputElement>(`#${toggle.getAttribute("aria-controls")} input`);
  assert.ok(field, "a field inside the opened row");
  field.focus();
  await act(async () => {
    toggle.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    field.blur();
  });
  assert.equal(window.document.activeElement, window.document.body, "WebKit's mousedown left focus on the body");
  await act(async () => { toggle.click(); });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assertFocused(window.document.activeElement, toggle, "after closing");
});

test("opening another row by mouse leaves focus where it was", async (t) => {
  const { window, container } = await mount(t, []);
  const toggles = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
  const first = toggles.find((button) => button.textContent?.includes("Team A"));
  const second = toggles.find((button) => button.textContent?.includes("Team B"));
  assert.ok(first && second, "both rows");
  await act(async () => { first.click(); });
  const field = container.querySelector<HTMLInputElement>(`#${first.getAttribute("aria-controls")} input`);
  assert.ok(field, "a field inside the first row");
  field.focus();
  await act(async () => {
    second.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    second.click();
  });
  assert.equal(second.getAttribute("aria-expanded"), "true");
  assertFocused(window.document.activeElement, field, "after opening the other row");
});
