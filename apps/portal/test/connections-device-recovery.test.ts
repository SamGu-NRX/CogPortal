import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, type InitialEntry } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { ConnectionSummary, Session } from "@cogworks/contracts/schema";

/**
 * A device code the server refuses for good (410 link_expired) used to leave
 * its Approve form on screen with nothing to do but fail again, and the page
 * offered the command for a fresh code only to an account with no device.
 * These pin the recovery: the refusal ends that code's form for this account
 * and this history entry only, offers the full link command, keeps every
 * linked device, and never turns an ordinary failure into an expiry.
 */

const KEY = "cogportal.heldDeviceLink";
const LAPTOP = { id: "device_1", name: "Lab laptop", createdAt: 1_750_000_000_000, lastUsedAt: null };
const DESKTOP = { id: "device_2", name: "Desk tower", createdAt: 1_750_000_100_000, lastUsedAt: 1_750_000_200_000 };
const LINK_EXPIRED = () =>
  Response.json({ error: { code: "link_expired", message: "The device code is invalid, expired, or already used." } }, { status: 410 });
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

type Handler = (path: string, init: { method?: string; body?: string }) => Promise<Response> | Response | undefined;

async function mount(t: TestContext, entry: InitialEntry, devices: ConnectionSummary["cliDevices"], handler: Handler = () => undefined) {
  const href = typeof entry === "string" ? entry : `${entry.pathname ?? ""}${entry.search ?? ""}`;
  const window = new Window({ url: `https://portal.example${href}` });
  let summary: ConnectionSummary = { github: null, discord: null, cliDevices: devices };
  const requests: string[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init: { method?: string; body?: string } = {}) => {
      const path = new URL(input, "https://portal.example").pathname;
      requests.push(`${init.method ?? "GET"} ${path}`);
      const handled = await handler(path, init);
      if (handled) return handled;
      if (path === "/api/v1/connections") return Response.json(summary);
      if (path === "/api/v1/cli/devices" && init.method === "DELETE") {
        const { deviceId } = JSON.parse(init.body ?? "{}") as { deviceId: string };
        summary = { ...summary, cliDevices: summary.cliDevices.filter((device) => device.id !== deviceId) };
        return Response.json(summary);
      }
      if (path === "/api/v1/cli/device/status") return Response.json({ valid: true, approved: true, expiresAt: null });
      throw new Error(`unexpected request ${init.method ?? "GET"} ${path}`);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity } },
  });
  client.setQueryData(["connections"], summary);
  client.setQueryData(["session"], session("ada"));
  const { ConnectionsPage } = await import("../src/routes/ConnectionsPage.tsx");
  const router = createMemoryRouter([
    { path: "/connections", element: React.createElement(ConnectionsPage) },
    { path: "/setup", element: React.createElement("h1", null, "Setup") },
  ], {
    initialEntries: [entry],
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
  const root = createRoot(container as unknown as Element);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };
  t.after(async () => {
    await unmount();
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })),
  ));
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  const button = (name: RegExp) =>
    [...container.querySelectorAll("button")].find((node) => name.test(node.textContent?.trim() ?? "")) as unknown as HTMLElement | undefined;
  const approve = async () => {
    const found = button(/^Approve device$/);
    assert.ok(found, "the Approve form is on screen");
    found.focus();
    await act(async () => found.click());
    await settle();
  };
  const navigate = async (to: InitialEntry) => {
    await act(async () => router.navigate(to as string));
    await settle();
  };
  const text = () => container.textContent ?? "";
  return { window, container, client, router, requests, settle, button, approve, navigate, text, unmount };
}

const refusalLine = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-request-outcome]")].find((node) => /can't be approved/.test(node.textContent ?? ""));

test("a refused code gives way to the full link command, and every linked device stays", async (t) => {
  const page = await mount(t, "/connections?user_code=dead-0000&return_to=setup", [LAPTOP, DESKTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? LINK_EXPIRED() : undefined);
  await page.approve();

  assert.ok(page.requests.includes("POST /api/v1/cli/device/approve"));
  assert.equal(page.button(/^Approve device$/), undefined, "the dead code's form is gone");
  assert.equal(page.router.state.location.search, "?return_to=setup", "the code left the address, nothing else did");
  assert.deepEqual(page.router.state.location.state, { deviceOutcome: { kind: "refused", code: "DEAD-0000", login: "ada" } });

  const line = refusalLine(page.container);
  assert.equal(line?.textContent?.replace(/\s+/g, " ").trim(), "The code DEAD-0000 is invalid, expired, or already used, so it can't be approved.");
  assert.ok(page.window.document.activeElement === line, "focus moves to the outcome");
  assert.match(page.text(), /If that terminal is still waiting, Ctrl\+C stops it\./);
  assert.match(page.text(), /cogworks link --portal https:\/\/portal\.example/);
  assert.match(page.text(), /Your other linked devices are unchanged\./);
  assert.doesNotMatch(page.text(), /already finished linking|in the list below/);
  for (const name of ["Lab laptop", "Desk tower"]) assert.match(page.text(), new RegExp(name));
  assert.equal([...page.container.querySelectorAll("button")].filter((node) => /^Revoke/.test(node.textContent?.trim() ?? "")).length, 2);
});

test("with no linked device, the refusal says nothing about other devices", async (t) => {
  const page = await mount(t, "/connections?user_code=DEAD-0000", [], (path) =>
    path === "/api/v1/cli/device/approve" ? LINK_EXPIRED() : undefined);
  await page.approve();
  assert.ok(refusalLine(page.container));
  assert.doesNotMatch(page.text(), /other linked devices/);
});

test("a refusal forgets the matching held link, asks for its status again, and writes no status", async (t) => {
  for (const [name, heldCode, kept] of [["the same code", "DEAD-0000", false], ["a different code", "WXYZ-2345", true]] as const) {
    await t.test(name, async (t) => {
      const page = await mount(t, "/connections?user_code=DEAD-0000", [LAPTOP], (path) =>
        path === "/api/v1/cli/device/approve" ? LINK_EXPIRED() : undefined);
      const held = JSON.stringify({ path: `/connections?user_code=${heldCode}&return_to=setup`, userCode: heldCode, login: "ada" });
      page.window.sessionStorage.setItem(KEY, held);
      // What the status endpoint last said. Another account's approved code
      // also answers 410 here, so the refusal must not overwrite this.
      const before = { valid: true, approved: true, expiresAt: 1_900_000_000_000 };
      page.client.setQueryData(["device-link-status", "DEAD-0000"], before);
      await page.approve();
      assert.equal(page.window.sessionStorage.getItem(KEY), kept ? held : null);
      assert.deepEqual(page.client.getQueryData(["device-link-status", "DEAD-0000"]), before, "no status is invented");
      assert.equal(page.client.getQueryState(["device-link-status", "DEAD-0000"])?.isInvalidated, true, "it will be asked again");
    });
  }
});

test("a refusal that arrives after the page has gone still forgets the held link", async (t) => {
  let answer: (response: Response) => void = () => undefined;
  const page = await mount(t, "/connections?user_code=DEAD-0000", [LAPTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? new Promise<Response>((resolve) => { answer = resolve; }) : undefined);
  page.window.sessionStorage.setItem(KEY, JSON.stringify({ path: "/connections?user_code=DEAD-0000", userCode: "DEAD-0000", login: "ada" }));
  await page.approve();
  await page.unmount();
  await act(async () => answer(LINK_EXPIRED()));
  await page.settle();
  assert.equal(page.window.sessionStorage.getItem(KEY), null);
});

test("a late refusal for an earlier code leaves the current code's form, address and held link alone", async (t) => {
  let answerA: (response: Response) => void = () => undefined;
  const page = await mount(t, "/connections?user_code=AAAA-1111", [LAPTOP], (path, init) => {
    if (path !== "/api/v1/cli/device/approve") return undefined;
    const { userCode } = JSON.parse(init.body ?? "{}") as { userCode: string };
    return userCode === "AAAA-1111" ? new Promise<Response>((resolve) => { answerA = resolve; }) : Response.json({ ok: true });
  });
  await page.approve();
  await page.navigate("/connections?user_code=BBBB-2222");
  const heldB = JSON.stringify({ path: "/connections?user_code=BBBB-2222", userCode: "BBBB-2222", login: "ada" });
  page.window.sessionStorage.setItem(KEY, heldB);

  await act(async () => answerA(LINK_EXPIRED()));
  await page.settle();

  assert.ok(page.button(/^Approve device$/), "B's form is still there");
  assert.match(page.text(), /BBBB-2222/);
  assert.equal(page.router.state.location.search, "?user_code=BBBB-2222");
  assert.equal(page.router.state.location.state, null);
  assert.equal(refusalLine(page.container), undefined);
  assert.equal(page.container.querySelector('[role="alert"]'), null, "A's error is not shown under B");
  assert.equal(page.window.sessionStorage.getItem(KEY), heldB);
});

for (const [name, reply] of [
  ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
  ["a server error", () => Response.json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 })],
] as const) {
  test(`${name} keeps the form and its retry, and is never read as an expiry`, async (t) => {
    let calls = 0;
    const page = await mount(t, "/connections?user_code=GOOD-0000", [LAPTOP], (path) => {
      if (path !== "/api/v1/cli/device/approve") return undefined;
      calls += 1;
      return calls === 1 ? reply() : Response.json({ ok: true });
    });
    page.window.sessionStorage.setItem(KEY, JSON.stringify({ path: "/connections?user_code=GOOD-0000", userCode: "GOOD-0000", login: "ada" }));
    await page.approve();
    assert.ok(page.button(/^Approve device$/), "the form stays");
    assert.equal(page.router.state.location.search, "?user_code=GOOD-0000");
    assert.equal(refusalLine(page.container), undefined);
    assert.ok(page.container.querySelector('[role="alert"]'), "the failure is shown");
    assert.notEqual(page.window.sessionStorage.getItem(KEY), null, "the held link is kept");
    await page.approve();
    assert.match(page.text(), /Device approved/);
  });
}

test("the refusal stays with its entry: not a plain visit, a new code or another account", async (t) => {
  const page = await mount(t, "/connections?user_code=DEAD-0000", [LAPTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? LINK_EXPIRED() : undefined);
  await page.approve();
  assert.ok(refusalLine(page.container));

  await act(async () => page.client.setQueryData(["session"], session("grace")));
  await page.settle();
  assert.equal(refusalLine(page.container), undefined, "another account in the tab doesn't see it");
  await act(async () => page.client.setQueryData(["session"], session("ada")));
  await page.settle();

  await page.navigate("/connections?user_code=NEWC-0DE0");
  assert.equal(refusalLine(page.container), undefined);
  assert.ok(page.button(/^Approve device$/), "a new code gets its own form");

  await page.navigate("/connections");
  assert.equal(refusalLine(page.container), undefined, "a plain visit shows ordinary Connections");
});

for (const [name, entry, shown] of [
  ["a typed refused_code parameter", "/connections?refused_code=DEAD-0000", false],
  ["state for another account", { pathname: "/connections", state: { deviceOutcome: { kind: "refused", code: "DEAD-0000", login: "grace" } } }, false],
  // Shown, as text: the server refuses malformed codes with the same 410.
  ["a markup-shaped code in state", { pathname: "/connections", state: { deviceOutcome: { kind: "refused", code: "<img src=x>", login: "ada" } } }, true],
  ["an empty code in state", { pathname: "/connections", state: { deviceOutcome: { kind: "refused", code: "", login: "ada" } } }, false],
  ["an unknown outcome kind", { pathname: "/connections", state: { deviceOutcome: { kind: "pending", code: "DEAD-0000", login: "ada" } } }, false],
  ["state that isn't an object", { pathname: "/connections", state: "DEAD-0000" }, false],
  ["state with the wrong types", { pathname: "/connections", state: { deviceOutcome: { kind: "refused", code: 7, login: "ada" } } }, false],
  ["the old flat shape", { pathname: "/connections", state: { refusedDeviceCode: "DEAD-0000", login: "ada" } }, false],
  ["this account's own refusal, as a reload keeps it", { pathname: "/connections", state: { deviceOutcome: { kind: "refused", code: "DEAD-0000", login: "ada" } } }, true],
] as const) {
  test(`navigation state: ${name}`, async (t) => {
    const page = await mount(t, entry as InitialEntry, [LAPTOP]);
    await page.settle();
    assert.equal(Boolean(refusalLine(page.container)), shown);
    assert.match(page.text(), /Lab laptop/);
    assert.equal(page.container.querySelector("img"), null, "state is never markup");
  });
}

test("approving one code doesn't hide the form for the next code opened", async (t) => {
  const page = await mount(t, "/connections?user_code=AAAA-1111", [LAPTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? Response.json({ ok: true }) : undefined);
  await page.approve();
  assert.match(page.text(), /Device approved/);
  await page.navigate("/connections?user_code=BBBB-2222");
  assert.ok(page.button(/^Approve device$/), "B gets its own form");
  assert.doesNotMatch(page.text(), /Device approved/);
});

test("a revoke that fails (fault injected) keeps both devices and its retry, and the retry removes only that one", async (t) => {
  let failures = 1;
  const page = await mount(t, "/connections", [LAPTOP, DESKTOP], (path, init) => {
    if (path === "/api/v1/cli/devices" && init.method === "DELETE" && failures > 0) {
      failures -= 1;
      return Response.json({ error: { code: "internal", message: "The device couldn't be revoked. Try again." } }, { status: 500 });
    }
    return undefined;
  });
  const rows = () => [...page.container.querySelectorAll("li")].filter((node) => /Lab laptop|Desk tower/.test(node.textContent ?? ""));
  const revoke = async (name: string) => {
    const row = rows().find((node) => node.textContent?.includes(name))!;
    const arm = [...row.querySelectorAll("button")].find((node) => /^Revoke/.test(node.textContent?.trim() ?? "")) as unknown as HTMLElement;
    arm.focus();
    await act(async () => arm.click());
    const confirm = [...row.querySelectorAll("button")].find((node) => /^Confirm, it stops reporting/.test(node.textContent?.trim() ?? "")) as unknown as HTMLElement;
    confirm.focus();
    await act(async () => confirm.click());
    await page.settle();
  };

  await revoke("Lab laptop");
  assert.deepEqual(rows().map((node) => node.querySelector(".font-semibold")?.textContent), ["Lab laptop", "Desk tower"]);
  const alerts = [...page.container.querySelectorAll('[role="alert"]')];
  assert.equal(alerts.length, 1);
  assert.ok(rows()[0]!.contains(alerts[0]!), "the error sits under the device that failed");
  assert.ok(rows()[1]!.querySelector("button"), "the other device keeps its Revoke");

  await revoke("Lab laptop");
  assert.deepEqual(rows().map((node) => node.querySelector(".font-semibold")?.textContent), ["Desk tower"]);
  assert.equal(page.container.querySelector('[role="alert"]'), null);
});

test("a late approval for an earlier code leaves the current code's form and address, and still records A as approved", async (t) => {
  let answerA: (response: Response) => void = () => undefined;
  const page = await mount(t, "/connections?user_code=AAAA-1111&return_to=setup", [LAPTOP], (path, init) => {
    if (path !== "/api/v1/cli/device/approve") return undefined;
    const { userCode } = JSON.parse(init.body ?? "{}") as { userCode: string };
    return userCode === "AAAA-1111" ? new Promise<Response>((resolve) => { answerA = resolve; }) : undefined;
  });
  await page.approve();
  await page.navigate("/connections?user_code=BBBB-2222&return_to=setup");
  await act(async () => answerA(Response.json({ ok: true })));
  await page.settle();

  assert.ok(page.button(/^Approve device$/), "B's form is still there");
  assert.equal(page.router.state.location.search, "?user_code=BBBB-2222&return_to=setup");
  assert.equal(page.router.state.location.state, null);
  assert.doesNotMatch(page.text(), /Device approved/);
  // The page ignores A's answer; the hook still records what the server said.
  assert.deepEqual(page.client.getQueryData(["device-link-status", "AAAA-1111"]), { valid: true, approved: true, expiresAt: null });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });
  assert.equal(page.router.state.location.pathname, "/connections", "no return to Setup on A's behalf");
});

test("approving with a return to Setup goes there, unless the reader opens another code first", async (t) => {
  await t.test("staying on the approved entry returns to Setup", async (t) => {
    const page = await mount(t, "/connections?user_code=AAAA-1111&return_to=setup", [LAPTOP], (path) =>
      path === "/api/v1/cli/device/approve" ? Response.json({ ok: true }) : undefined);
    await page.approve();
    assert.match(page.text(), /Device approved\. You can return to the terminal; returning to Setup/);
    assert.deepEqual(page.router.state.location.state, { deviceOutcome: { kind: "approved", code: "AAAA-1111", login: "ada" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });
    assert.equal(page.router.state.location.pathname, "/setup");
  });
  await t.test("opening code B within 900ms cancels the return", async (t) => {
    const page = await mount(t, "/connections?user_code=AAAA-1111&return_to=setup", [LAPTOP], (path) =>
      path === "/api/v1/cli/device/approve" ? Response.json({ ok: true }) : undefined);
    await page.approve();
    assert.match(page.text(), /Device approved/);
    await page.navigate("/connections?user_code=BBBB-2222&return_to=setup");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });
    assert.equal(page.router.state.location.pathname, "/connections");
    assert.equal(page.router.state.location.search, "?user_code=BBBB-2222&return_to=setup");
    assert.ok(page.button(/^Approve device$/), "B's form is still there");
  });
});

for (const [name, reply] of [
  ["an approval", () => Response.json({ ok: true })],
  ["a refusal", LINK_EXPIRED],
] as const) {
  test(`${name} sent by one account doesn't settle the same code's form after the account changes`, async (t) => {
    let answer: (response: Response) => void = () => undefined;
    const page = await mount(t, "/connections?user_code=SAME-0000", [LAPTOP], (path) =>
      path === "/api/v1/cli/device/approve" ? new Promise<Response>((resolve) => { answer = resolve; }) : undefined);
    await page.approve();
    await act(async () => page.client.setQueryData(["session"], session("grace")));
    await page.settle();
    await act(async () => answer(reply()));
    await page.settle();

    assert.ok(page.button(/^Approve device$/), "the form for grace stays");
    assert.equal(page.router.state.location.search, "?user_code=SAME-0000");
    assert.equal(page.router.state.location.state, null);
    assert.doesNotMatch(page.text(), /Device approved|can't be approved/);
    assert.equal(page.container.querySelector('[role="alert"]'), null, "the other account's error isn't shown");
  });
}

const announcement = (container: HTMLElement) => container.querySelector("[data-device-announcement]")?.textContent ?? null;

test("the code is trimmed and upper-cased once, so a pasted trailing space still approves", async (t) => {
  const sent: string[] = [];
  const page = await mount(t, "/connections?user_code=abcd-efgh%20%20", [LAPTOP], (path, init) => {
    if (path !== "/api/v1/cli/device/approve") return undefined;
    sent.push((JSON.parse(init.body ?? "{}") as { userCode: string }).userCode);
    return Response.json({ ok: true });
  });
  assert.match(page.text(), /ABCD-EFGH/);
  await page.approve();
  assert.deepEqual(sent, ["ABCD-EFGH"]);
  assert.match(page.text(), /Device approved/);
  assert.deepEqual(page.router.state.location.state, { deviceOutcome: { kind: "approved", code: "ABCD-EFGH", login: "ada" } });
});

test("a malformed code the server refuses still gets the recovery, with the code as text", async (t) => {
  const page = await mount(t, "/connections?user_code=bad_code", [LAPTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? LINK_EXPIRED() : undefined);
  await page.approve();
  assert.equal(
    refusalLine(page.container)?.textContent?.replace(/\s+/g, " ").trim(),
    "The code BAD_CODE is invalid, expired, or already used, so it can't be approved.",
  );
  assert.match(page.text(), /cogworks link --portal https:\/\/portal\.example/);
});

test("an oversized refused code isn't printed, and the recovery still renders", async (t) => {
  const huge = "X".repeat(300);
  const page = await mount(t, `/connections?user_code=${huge}`, [LAPTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? LINK_EXPIRED() : undefined);
  await page.approve();
  assert.equal(
    refusalLine(page.container)?.textContent?.replace(/\s+/g, " ").trim(),
    "That code is invalid, expired, or already used, so it can't be approved.",
  );
  assert.doesNotMatch(page.text(), /X{65}/);
  assert.match(page.text(), /cogworks link --portal/);
  assert.match(page.text(), /Your other linked devices are unchanged\./);
});

test("an earlier code still out doesn't block the next one, and its own cleanup still runs", async (t) => {
  let answerA: (response: Response) => void = () => undefined;
  const sent: string[] = [];
  const page = await mount(t, "/connections?user_code=AAAA-1111", [LAPTOP], (path, init) => {
    if (path !== "/api/v1/cli/device/approve") return undefined;
    const { userCode } = JSON.parse(init.body ?? "{}") as { userCode: string };
    sent.push(userCode);
    return userCode === "AAAA-1111" ? new Promise<Response>((resolve) => { answerA = resolve; }) : Response.json({ ok: true });
  });
  const heldA = JSON.stringify({ path: "/connections?user_code=AAAA-1111", userCode: "AAAA-1111", login: "ada" });
  page.window.sessionStorage.setItem(KEY, heldA);
  await page.approve();
  await page.navigate("/connections?user_code=BBBB-2222");
  const approveB = page.button(/^Approve device$/);
  assert.ok(approveB);
  assert.equal(approveB.getAttribute("aria-disabled"), null, "B is not busy with A's request");
  await page.approve();
  assert.deepEqual(sent, ["AAAA-1111", "BBBB-2222"]);
  assert.match(page.text(), /Device approved/);
  assert.equal(page.window.sessionStorage.getItem(KEY), heldA, "B's approval leaves A's held link");

  await act(async () => answerA(Response.json({ ok: true })));
  await page.settle();
  assert.equal(page.window.sessionStorage.getItem(KEY), null, "A's own answer still releases A");
  assert.deepEqual(page.router.state.location.state, { deviceOutcome: { kind: "approved", code: "BBBB-2222", login: "ada" } });
});

test("a refusal is announced without moving focus that went elsewhere", async (t) => {
  let answer: (response: Response) => void = () => undefined;
  const page = await mount(t, "/connections?user_code=DEAD-0000", [LAPTOP, DESKTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? new Promise<Response>((resolve) => { answer = resolve; }) : undefined);
  assert.equal(announcement(page.container), "", "the live region is there before anything happens");
  await page.approve();
  const elsewhere = [...page.container.querySelectorAll("li button")].find((node) => /^Revoke/.test(node.textContent?.trim() ?? "")) as unknown as HTMLElement;
  elsewhere.focus();
  await act(async () => answer(LINK_EXPIRED()));
  await page.settle();
  assert.ok(refusalLine(page.container));
  assert.ok(page.window.document.activeElement === (elsewhere as unknown), "focus stays where the reader put it");
  assert.equal(
    announcement(page.container),
    "The code DEAD-0000 is invalid, expired, or already used, so it can't be approved. Use the command below to request a fresh code.",
  );
  assert.equal(page.container.querySelector("[data-device-announcement] button, [data-device-announcement] code"), null);
});

test("an answer for the same code on an earlier entry doesn't settle the reopened one", async (t) => {
  let answer: (response: Response) => void = () => undefined;
  const page = await mount(t, "/connections?user_code=SAME-0000&return_to=setup", [LAPTOP], (path) =>
    path === "/api/v1/cli/device/approve" ? new Promise<Response>((resolve) => { answer = resolve; }) : undefined);
  page.window.sessionStorage.setItem(KEY, JSON.stringify({ path: "/connections?user_code=SAME-0000&return_to=setup", userCode: "SAME-0000", login: "ada" }));
  await page.approve();
  const firstEntry = page.router.state.location.key;
  await page.navigate("/connections?user_code=SAME-0000&return_to=setup");
  assert.notEqual(page.router.state.location.key, firstEntry);
  await act(async () => answer(LINK_EXPIRED()));
  await page.settle();
  assert.ok(page.button(/^Approve device$/), "the reopened entry keeps its form");
  assert.equal(page.router.state.location.search, "?user_code=SAME-0000&return_to=setup");
  assert.equal(page.router.state.location.state, null);
  assert.equal(refusalLine(page.container), undefined);
  assert.equal(page.window.sessionStorage.getItem(KEY), null, "the hook still forgets the refused code");
});
