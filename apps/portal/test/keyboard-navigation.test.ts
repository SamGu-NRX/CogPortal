import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { Window } from "happy-dom";
import { Button } from "../src/components/Button.tsx";
import { ScrollToTopOnNavigate } from "../src/components/Shell.tsx";

/**
 * Two keyboard defects found at 200% zoom. A busy Button was natively
 * disabled, and the browser blurs a focused button that becomes disabled, so
 * keyboard focus fell to the page. And BrowserRouter kept the previous page's
 * offset, so a link from the foot of Setup opened Runs at its foot.
 */

function dom(t: TestContext) {
  const window = new Window({ url: "https://portal.example/a" });
  const scrollTo = t.mock.method(window, "scrollTo", () => undefined);
  const scrolls = () => scrollTo.mock.calls.map((call) => call.arguments);
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { window, container, root, scrolls };
}

test("a busy Button stays focusable and swallows clicks and form submits", async (t) => {
  const { container, root } = dom(t);
  let clicks = 0;
  let submits = 0;
  const render = (busy: boolean) => act(async () => root.render(
    React.createElement("form", { onSubmit: (event: React.FormEvent) => { event.preventDefault(); submits += 1; } },
      React.createElement(Button, { type: "submit", busy, onClick: () => { clicks += 1; } }, "Approve")),
  ));
  await render(false);
  const button = container.querySelector("button");
  assert.ok(button);
  await act(async () => button.click());
  assert.equal(clicks, 1, "an idle button runs its click");
  assert.equal(submits, 1, "an idle submit button submits its form");

  await render(true);
  assert.equal(button.disabled, false, "busy must not set native disabled, which drops focus");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(button.getAttribute("aria-busy"), "true");
  await act(async () => button.click());
  await act(async () => button.click());
  assert.equal(clicks, 1, "a busy button does not run its click again");
  assert.equal(submits, 1, "a busy submit button does not submit again");
});

test("a genuinely disabled Button stays natively disabled, and a caller's aria-disabled survives", async (t) => {
  const { container, root } = dom(t);
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(Button, { disabled: true }, "No quota"),
    React.createElement(Button, { "aria-disabled": true }, "Checking"),
  )));
  const [disabled, ariaDisabled] = container.querySelectorAll("button");
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.hasAttribute("aria-disabled"), false);
  assert.equal(ariaDisabled.getAttribute("aria-disabled"), "true");
});

test("a new page opens at the top; Back, same-page URL changes and a page's own target keep their offset", async (t) => {
  const { root, scrolls } = dom(t);
  // A page that scrolls to its own target in a layout effect, as Setup does for a hash.
  function Target() {
    useLayoutEffect(() => { window.scrollTo(0, 500); }, []);
    return null;
  }
  const router = createMemoryRouter([{
    element: React.createElement(React.Fragment, null,
      React.createElement(ScrollToTopOnNavigate), React.createElement(Outlet)),
    children: [
      { path: "/a", element: null },
      { path: "/b", element: null },
      { path: "/setup", element: React.createElement(Target) },
    ],
  }], { initialEntries: ["/a"] });
  await act(async () => root.render(React.createElement(RouterProvider, { router })));
  assert.deepEqual(scrolls(), [], "the first load keeps the browser's own offset");

  await act(async () => router.navigate("/b"));
  assert.deepEqual(scrolls(), [[0, 0]], "a link to another page opens it at the top");

  await act(async () => router.navigate("/a", { replace: true }));
  assert.deepEqual(scrolls().at(-1), [0, 0], "a redirect to another page opens it at the top");
  const afterRedirect = scrolls().length;

  await act(async () => router.navigate("/a?user_code=", { replace: true }));
  await act(async () => router.navigate("/a?path=join"));
  assert.equal(scrolls().length, afterRedirect, "a same-page URL change does not scroll");

  await act(async () => router.navigate(-1));
  assert.equal(scrolls().length, afterRedirect, "Back keeps the browser's restored offset");

  await act(async () => router.navigate("/setup#step-clone"));
  assert.deepEqual(scrolls().slice(afterRedirect), [[0, 0], [0, 500]], "the page's own target wins");
});
