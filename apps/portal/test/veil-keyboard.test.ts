import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { Veil } from "../src/components/Veil.tsx";

/**
 * Veil now skips its motion when the toggle is pressed from the keyboard or
 * by assistive technology (a click with `detail` 0). That timing is checked in
 * a browser; these pin what must not change with it: keyboard expansion still
 * moves focus into the region, a pointer's doesn't, and folded content is
 * inert and hidden from assistive technology in both directions.
 */

async function mount(t: TestContext) {
  const window = new Window({ url: "https://portal.example/" });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () =>
    root.render(
      React.createElement(
        Veil,
        { count: 2, moreLabel: "See 2 more", focusSelector: "a" },
        React.createElement("a", { href: "#first" }, "first folded item"),
        React.createElement("a", { href: "#second" }, "second folded item"),
      ),
    ),
  );
  const toggle = container.querySelector("button[aria-expanded]");
  assert.ok(toggle, "the Veil renders its toggle");
  const region = container.ownerDocument.getElementById(toggle.getAttribute("aria-controls") ?? "");
  assert.ok(region, "the toggle names its region");
  const folded = region.querySelector("[aria-hidden]");
  assert.ok(folded, "the folded items sit in their own wrapper");
  return { window, toggle, folded };
}

/** A click as a pointer sends it (detail 1) or as Enter, Space or a screen reader does (detail 0). */
async function press(window: Window, toggle: Element, detail: 0 | 1) {
  await act(async () => {
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

test("a keyboard expansion moves focus into the region; collapsing keeps it on the toggle", async (t) => {
  const { window, toggle, folded } = await mount(t);
  (toggle as unknown as HTMLButtonElement).focus();

  await press(window, toggle, 0);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(folded.getAttribute("aria-hidden"), "false");
  assert.equal(folded.hasAttribute("inert"), false);
  assert.equal(window.document.activeElement?.textContent, "first folded item", "focus moved to the first item");

  (toggle as unknown as HTMLButtonElement).focus();
  await press(window, toggle, 0);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(folded.getAttribute("aria-hidden"), "true");
  assert.equal(folded.hasAttribute("inert"), true);
  assert.equal(window.document.activeElement, toggle as unknown, "collapse leaves focus on the toggle");
});

test("a pointer expansion leaves focus where it was", async (t) => {
  const { window, toggle, folded } = await mount(t);
  (toggle as unknown as HTMLButtonElement).focus();

  await press(window, toggle, 1);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(folded.getAttribute("aria-hidden"), "false");
  assert.equal(window.document.activeElement, toggle as unknown);

  await press(window, toggle, 1);
  assert.equal(folded.getAttribute("aria-hidden"), "true");
  assert.equal(folded.hasAttribute("inert"), true);
});

test("switching from pointer to keyboard mid-toggle keeps the state and the focus rules", async (t) => {
  const { window, toggle, folded } = await mount(t);
  (toggle as unknown as HTMLButtonElement).focus();

  await press(window, toggle, 1);
  await press(window, toggle, 0);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(folded.getAttribute("aria-hidden"), "true");
  assert.equal(window.document.activeElement, toggle as unknown);

  await press(window, toggle, 0);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(window.document.activeElement?.textContent, "first folded item");
});
