import assert from "node:assert/strict";
import test from "node:test";
import { clearPendingReturn, pendingReturn, rememberReturn } from "../src/lib/pending-return.ts";

/**
 * The saved return is navigated to after sign-in, so it has one correct
 * answer: a same-origin path to a page an outside link can name, and nothing
 * else, whether it arrives through the guard or was planted in storage.
 */

function withStorage(run: (values: Map<string, string>) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  try {
    run(values);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

test("links from the CLI, Discord and the Activity are kept", () => {
  for (const path of [
    "/connections?user_code=ABCD-EFGH-IJKL",
    "/connections?user_code=ABCD-EFGH-IJKL&return_to=setup",
    "/connections#discord=state-token",
    "/runs/run_demo_p1",
    "/run-surfaces/surface_0a1b2c3d4e",
    "/runs/run_demo_p1/",
  ]) {
    withStorage(() => {
      rememberReturn(path);
      assert.equal(pendingReturn(), path);
    });
  }
});

test("other origins and pages sign-in has no reason to restore are refused", () => {
  for (const path of [
    "//evil.example/runs/run_1",
    "https://evil.example/runs/run_1",
    "/\\evil.example",
    "/runs/../admin",
    "/runs/run_1/../../admin",
    "/runs/%2e%2e",
    "/runs/run_1?next=//evil.example",
    "/runs/run_1#x",
    "/runs/",
    "/runs/run_1//",
    "/run-surfaces/a/b",
    "/connections",
    "/connections?return_to=setup",
    "/dashboard",
    "/admin",
    "/team",
    "",
  ]) {
    withStorage((values) => {
      rememberReturn("/runs/run_earlier");
      rememberReturn(path);
      assert.equal(values.size, 0, `${JSON.stringify(path)} is not saved and replaces the earlier link`);
      values.set("cogportal.pendingReturn", path);
      assert.equal(pendingReturn(), null, `${JSON.stringify(path)} is not read back`);
    });
  }
});

test("a browser that denies session storage still renders, without a return", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  });
  try {
    assert.doesNotThrow(() => rememberReturn("/runs/run_demo_p1"));
    assert.equal(pendingReturn(), null);
    assert.doesNotThrow(() => clearPendingReturn());
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
