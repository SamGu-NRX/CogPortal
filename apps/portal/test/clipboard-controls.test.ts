import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { AdminOverview } from "@cogworks/contracts/schema";
import { ShaChip } from "../src/components/ShaChip.tsx";
import { AdminPage } from "../src/routes/AdminPage.tsx";

const sha = "0123456789abcdef0123456789abcdef01234567";
const joinCode = "LAB-CODE";

function admin(t: TestContext, scope: AdminOverview["scope"] = "owner") {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
  client.setQueryData<AdminOverview>(["admin", "overview"], {
    scope,
    cohort: { slug: "test", name: "Test cohort", joinCode: scope === "owner" ? joinCode : null, active: true },
    teams: [],
    unassigned: [],
  });
  client.setQueryData(["admin", "staff"], { entries: [], owners: [] });
  t.after(() => client.clear());
  return React.createElement(QueryClientProvider, { client }, React.createElement(AdminPage));
}

async function mount(t: TestContext, element: React.ReactNode) {
  const window = new Window({ url: "https://portal.example" });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // Happy DOM supplies a DOM implementation with its own TypeScript interfaces.
  // SAFETY: React receives the same Element operations it uses in a browser.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(element));
  return { window, container };
}

const controls = [
  {
    name: "SHA",
    value: sha,
    label: `Copy full commit SHA ${sha}`,
    render: () => React.createElement(ShaChip, { sha, shortSha: sha.slice(0, 7) }),
    recovery: "Copy the full SHA below manually",
  },
  {
    name: "cohort join code",
    value: joinCode,
    label: `Copy join code ${joinCode}`,
    render: admin,
    recovery: "Select the join code above and copy it manually",
  },
];

for (const control of controls) {
  test(`${control.name}: pending copy keeps its button, rejection recovers, and retry reports success`, async (t) => {
    const { window, container } = await mount(t, control.render(t));
    const button = container.querySelector(`button[aria-label="${control.label}"]`);
    assert.ok(button instanceof window.HTMLButtonElement);
    const status = () => [...container.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent.includes("copy") || node.textContent === "Copied.");
    assert.equal(status(), undefined);
    assert.equal(container.querySelector("textarea"), null);
    button.focus();

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = Promise.withResolvers<void>();
    const write = t.mock.method(window.navigator.clipboard, "writeText", () => pending.promise);
    await act(async () => { button.click(); button.click(); });
    assert.equal(write.mock.callCount(), 1, "overlapping activations issue one write");
    assert.deepEqual(write.mock.calls[0].arguments, [control.value]);
    assert.equal(button.disabled, false);
    assert.equal(window.document.activeElement, button);
    assert.equal(status(), undefined, "pending is not success");

    await act(async () => pending.reject(new Error("clipboard denied")));
    assert.match(status()?.textContent ?? "", /Couldn't copy/);
    assert.ok(status()?.textContent.includes(control.recovery));
    assert.equal(window.document.activeElement, button);
    assert.equal(container.querySelector(`button[aria-label="${control.label}"]`), button);
    await act(async () => t.mock.timers.tick(2000));
    assert.match(status()?.textContent ?? "", /Couldn't copy/, "failure does not time out");

    if (control.name === "SHA") {
      const recovery = container.querySelector('textarea[aria-label="Full commit SHA"]');
      assert.ok(recovery instanceof window.HTMLTextAreaElement);
      assert.equal(recovery.readOnly, true);
      assert.equal(recovery.value, sha);
      recovery.focus();
      recovery.select();
      assert.equal(recovery.value.slice(recovery.selectionStart, recovery.selectionEnd), sha);
      button.focus();
    } else {
      assert.equal(button.querySelector(".select-text")?.textContent, joinCode);
      assert.equal(container.textContent.split(joinCode).length - 1, 1, "recovery reuses the visible code");
    }

    write.mock.mockImplementation(async () => {});
    await act(async () => button.click());
    assert.equal(write.mock.callCount(), 2);
    assert.equal(status()?.textContent, "Copied.");
    assert.equal(container.querySelector("textarea"), null);
    assert.equal(window.document.activeElement, button);
    assert.equal(button.getAttribute("aria-label"), control.label);
    await act(async () => t.mock.timers.tick(1399));
    assert.equal(status()?.textContent, "Copied.");
    await act(async () => t.mock.timers.tick(1));
    assert.equal(status(), undefined);

    await act(async () => button.click());
    assert.equal(status()?.textContent, "Copied.");
    write.mock.mockImplementation(async () => { throw new Error("clipboard denied again"); });
    await act(async () => button.click());
    await act(async () => t.mock.timers.tick(2000));
    assert.match(status()?.textContent ?? "", /Couldn't copy/, "an old success timer cannot erase a newer failure");
    assert.equal(window.document.activeElement, button);
  });

  test(`${control.name}: missing clipboard API exposes manual recovery`, async (t) => {
    const { window, container } = await mount(t, control.render(t));
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: undefined });
    const button = container.querySelector(`button[aria-label="${control.label}"]`);
    assert.ok(button instanceof window.HTMLButtonElement);
    await act(async () => button.click());
    assert.ok(container.textContent.includes(control.recovery));
    assert.ok(!container.textContent.includes("Copied."));
  });
}

test("TA workspace does not render the owner-only join-code control or recovery", async (t) => {
  const { container } = await mount(t, admin(t, "ta"));
  assert.equal(container.querySelector('button[aria-label^="Copy join code"]'), null);
  assert.ok(!container.textContent.includes(joinCode));
  assert.ok(!container.textContent.includes("Rotate join code"));
});
