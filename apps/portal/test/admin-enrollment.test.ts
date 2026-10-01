import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { AdminOverview } from "@cogworks/contracts/schema";
import { AdminPage } from "../src/routes/AdminPage.tsx";

/**
 * The enrollment fold on the admin page. Rotating the join code never changes
 * whether enrollment is open (the server only touches `active` when it is
 * sent), so the sentence after a rotation has to follow the cohort as it is,
 * and the fold's actions must leave the keyboard and the accessibility tree
 * the moment it closes, while they are still animating out.
 */

type Cohort = AdminOverview["cohort"];

async function mount(t: TestContext, active: boolean) {
  const window = new Window({ url: "https://portal.example/admin" });
  let cohort: Cohort = { slug: "test", name: "Test cohort", joinCode: "OLD-CODE", active };
  const bodies: unknown[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init: { method?: string; body?: string }) => {
      assert.equal(input, "/api/admin/cohort");
      assert.equal(init.method, "PATCH");
      const body = JSON.parse(init.body ?? "{}") as { rotateJoinCode?: boolean; active?: boolean };
      bodies.push(body);
      cohort = {
        ...cohort,
        ...(body.rotateJoinCode ? { joinCode: `NEW-${bodies.length}` } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      };
      return Response.json(cohort);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
  client.setQueryData<AdminOverview>(["admin", "overview"], { scope: "owner", cohort, teams: [], unassigned: [] });
  client.setQueryData(["admin", "staff"], { entries: [], owners: [] });
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
  await act(async () =>
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(AdminPage))),
  );

  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
    assert.ok(found, `button "${text}"`);
    return found;
  };
  const press = async (text: string) => {
    await act(async () => button(text).click());
    // Let the PATCH resolve and the cache update land.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const toggle = () => button("Change enrollment");
  const fold = () => {
    const id = toggle().getAttribute("aria-controls");
    assert.ok(id);
    const node = window.document.getElementById(id);
    assert.ok(node);
    return node;
  };
  const rotation = () =>
    [...container.querySelectorAll('[role="status"]')].find((node) => /code (no longer|works)/.test(node.textContent))
      ?.textContent;
  const rotate = async () => {
    await press("Rotate join code");
    await press("Confirm, the old code stops working");
  };
  return { window, container, bodies, press, toggle, fold, rotation, rotate };
}

test("rotating while enrollment is closed does not say the new code works", async (t) => {
  const page = await mount(t, false);
  await page.press("Change enrollment");
  await page.rotate();
  assert.deepEqual(page.bodies, [{ rotateJoinCode: true }]);
  assert.ok(page.container.textContent.includes("NEW-1"));
  assert.ok(page.container.textContent.includes("Enrollment closed"));
  assert.equal(page.rotation(), "The old code no longer works. The new one will once you open enrollment.");
});

test("closing enrollment after a rotation changes what the rotation sentence claims", async (t) => {
  const page = await mount(t, true);
  await page.press("Change enrollment");
  await page.rotate();
  assert.equal(page.rotation(), "The new code works now, and the old one no longer does.");

  await page.press("Close enrollment");
  assert.deepEqual(page.bodies, [{ rotateJoinCode: true }, { active: false }]);
  assert.ok(page.container.textContent.includes("Enrollment closed"));
  assert.equal(page.rotation(), "The old code no longer works. The new one will once you open enrollment.");

  await page.press("Open enrollment");
  assert.equal(page.rotation(), "The new code works now, and the old one no longer does.");
});

test("a closing fold hides its actions at once and keeps focus on the toggle", async (t) => {
  const page = await mount(t, true);
  assert.equal(page.fold().hasAttribute("inert"), true);
  assert.equal(page.fold().getAttribute("aria-hidden"), "true");

  await page.press("Change enrollment");
  assert.equal(page.toggle().getAttribute("aria-expanded"), "true");
  assert.equal(page.fold().hasAttribute("inert"), false);
  assert.notEqual(page.fold().getAttribute("aria-hidden"), "true");
  const rotate = [...page.fold().querySelectorAll("button")].find((node) => node.textContent.trim() === "Rotate join code");
  assert.ok(rotate);
  rotate.focus();
  assert.equal(page.window.document.activeElement, rotate);

  // A mouse press in Safari leaves focus where it was, which click() mimics.
  await act(async () => page.toggle().click());
  assert.equal(page.toggle().getAttribute("aria-expanded"), "false");
  assert.equal(page.fold().hasAttribute("inert"), true);
  assert.equal(page.fold().getAttribute("aria-hidden"), "true");
  assert.equal(page.window.document.activeElement, page.toggle());
  // Motion is not reduced here, so the actions may still be animating out;
  // whatever is left sits inside the hidden wrapper.
  for (const node of page.container.querySelectorAll("button")) {
    if (/enrollment$|join code$/.test(node.textContent.trim()) && node !== page.toggle()) {
      assert.ok(page.fold().contains(node), `${node.textContent} outside the hidden fold`);
    }
  }
});
