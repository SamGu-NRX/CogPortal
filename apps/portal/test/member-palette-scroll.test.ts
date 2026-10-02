// First, so React DOM sees a document when it loads (see the fixture).
import "./fixtures/dom-before-react.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { InvitableUser } from "@cogworks/contracts/schema";
import { MemberPalette } from "../src/components/MemberPalette.tsx";

/**
 * The palette keeps focus in its search field and points at the active row
 * with aria-activedescendant, so the browser never scrolls the list for it.
 * The list shows about six rows; a cohort with more teamless students needs
 * the palette to bring the active row into view itself.
 */

const students: InvitableUser[] = Array.from({ length: 12 }, (_, index) => ({
  login: `student-${String(index).padStart(2, "0")}`,
  name: null,
  avatarUrl: null,
}));

async function mount(t: TestContext) {
  const window = new Window({ url: "https://portal.example/team" });
  const scrolled: string[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    fetch: async (input: string) => {
      throw new Error(`unexpected request ${input}`);
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolled.push(this.id);
  };
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity } },
  });
  client.setQueryData(["invitable"], students);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const trigger = React.createRef<HTMLButtonElement>();
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
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement("button", { ref: trigger, type: "button" }, "Add someone"),
        React.createElement(MemberPalette, { open: true, onClose: () => {}, triggerRef: trigger }),
      ),
    ),
  );
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.ok(input, "the search field");
  return { window, container, input, scrolled };
}

test("arrowing past the visible rows scrolls each new active student into view", async (t) => {
  const { window, container, input, scrolled } = await mount(t);
  for (let step = 1; step <= 8; step += 1) {
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const active = container.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    assert.ok(active, `an active row after ${step} presses`);
    assert.equal(active.textContent?.includes(students[step].login), true, `row ${step} is active`);
    assert.equal(scrolled.at(-1), active.id, `row ${step} was scrolled into view`);
    assert.equal(input.getAttribute("aria-activedescendant"), active.id);
  }
});
