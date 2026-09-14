import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window, type HTMLElement as HappyElement } from "happy-dom";
import { UserMenu } from "../src/components/UserMenu.tsx";

async function mount(t: TestContext, initialRight: number, initialViewport = 345) {
  const window = new Window({ url: "https://portal.example/dashboard" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let right = initialRight;
  let viewport = initialViewport;
  Object.defineProperty(window.document.documentElement, "clientWidth", { get: () => viewport });
  // Happy DOM has no layout. Supply the measured native anchor and unscaled menu width.
  const bounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return new window.DOMRect(right - 54, 44, 54, 44);
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return this.getAttribute("role") === "menu" ? Math.min(208, viewport - 32) : 54; },
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // SAFETY: Happy DOM implements the Element operations used by React DOM.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    window.HTMLElement.prototype.getBoundingClientRect = bounds;
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(MemoryRouter, { initialEntries: ["/dashboard"] },
        React.createElement(UserMenu, {
          user: { login: "menu-fixture", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
          hasTeam: true, isStaff: false, nextPath: "/dashboard",
        }),
      ),
    ),
  ));
  const trigger = container.querySelector("button");
  assert.ok(trigger);
  await act(async () => trigger.click());
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
  const menu = container.querySelector<HappyElement>('[role="menu"]');
  assert.ok(menu);
  return {
    window, container, trigger, menu,
    resize: async (nextRight: number, nextViewport = viewport) => {
      right = nextRight;
      viewport = nextViewport;
      await act(async () => window.dispatchEvent(new window.Event("resize")));
    },
  };
}

test("a wrapped left-edge trigger opens the account menu inside the viewport", async (t) => {
  const { menu } = await mount(t, 74);
  assert.equal(menu.style.right, "-154px");
  assert.equal(74 - Number.parseFloat(menu.style.right) - 208, 20);
  assert.equal(menu.style.transformOrigin, "54px top");
  assert.equal(menu.style.maxWidth, "313px");
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ["Dashboard", "Setup guide", "Team settings", "Connections", "Sign out"]);
});

test("a normal right-edge trigger keeps the existing right alignment at the same viewport width", async (t) => {
  const { menu } = await mount(t, 325);
  assert.equal(menu.style.right, "0px");
  assert.equal(menu.style.transformOrigin, "208px top");
});

test("resizing an open menu repositions it without replacing the focused item", async (t) => {
  const { menu, window, resize } = await mount(t, 74);
  const item = menu.querySelectorAll<HappyElement>('[role="menuitem"]')[1];
  item.focus();
  await resize(325);
  assert.equal(menu.style.right, "0px");
  assert.equal(window.document.activeElement, item);
  await resize(74);
  assert.equal(menu.style.right, "-154px");
  assert.equal(window.document.activeElement, item);
});

test("the popup respects both viewport edges and caps its width", async (t) => {
  const { menu, resize } = await mount(t, 350);
  assert.equal(menu.style.right, "21px");
  await resize(50, 200);
  assert.equal(menu.style.maxWidth, "168px");
  assert.equal(menu.style.right, "-134px");
  assert.equal(50 - Number.parseFloat(menu.style.right) - 168, 16);
});

test("arrow navigation and Escape still preserve the menu-button interaction", async (t) => {
  const { menu, window, trigger, resize } = await mount(t, 74);
  const items = menu.querySelectorAll<HappyElement>('[role="menuitem"]');
  items[0].focus();
  await act(async () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  assert.equal(window.document.activeElement, items[1]);
  await act(async () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(window.document.activeElement, trigger);
  const lastPosition = menu.style.right;
  await resize(325);
  assert.equal(menu.style.right, lastPosition, "a closed menu kept its resize listener");
});
