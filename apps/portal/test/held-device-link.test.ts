import assert from "node:assert/strict";
import test from "node:test";
import { heldDeviceLink, holdDeviceLink, releaseHeldDeviceLink } from "../src/lib/held-device-link.ts";
import { clearPendingReturn, pendingReturn } from "../src/lib/pending-return.ts";

/**
 * The held link becomes a link on Setup, so what it accepts has one correct
 * answer: the relative approval path the CLI prints, for the account that
 * opened it, and nothing else, whether it arrives through the guard or was
 * planted in storage.
 */

const KEY = "cogportal.heldDeviceLink";

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

function withDeniedStorage(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

function withThrowingMethods(methods: Array<"getItem" | "setItem" | "removeItem">, run: (values: Map<string, string>) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  const denied = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: methods.includes("getItem") ? denied : (key: string) => values.get(key) ?? null,
      setItem: methods.includes("setItem") ? denied : (key: string, value: string) => { values.set(key, value); },
      removeItem: methods.includes("removeItem") ? denied : (key: string) => { values.delete(key); },
    },
  });
  try {
    run(values);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

test("the CLI's approval path is held for the account that opened it, exactly as printed", () => {
  for (const path of ["/connections?user_code=ABCD-EFGH", "/connections?user_code=abcd-efgh&return_to=setup"]) {
    withStorage(() => {
      holdDeviceLink(path, "octocat");
      assert.deepEqual(heldDeviceLink("octocat"), { path, userCode: "ABCD-EFGH", login: "octocat" });
    });
  }
});

test("anything other than the CLI's relative approval path is refused and leaves the earlier link alone", () => {
  for (const path of [
    "/connections#discord=state-token",
    "/connections?user_code=",
    "/connections",
    "/connections?return_to=setup",
    "/connections?return_to=setup&user_code=ABCD-EFGH",
    "/connections?user_code=ABCD-EFGH&next=//evil.example",
    "/connections?user_code=ABCD-EFGH&return_to=dashboard",
    "/connections?user_code=ABCD%2FEFGH",
    "/connections?user_code=ABCD/EFGH",
    "/connections?user_code=ABCD-EFGH#x",
    "//evil.example/connections?user_code=ABCD-EFGH",
    "https://evil.example/connections?user_code=ABCD-EFGH",
    "/connections/?user_code=ABCD-EFGH",
    `/connections?user_code=${"A".repeat(65)}`,
    "/runs/run_demo_p1",
    "",
  ]) {
    withStorage((values) => {
      holdDeviceLink("/connections?user_code=EARL-IER1", "octocat");
      holdDeviceLink(path, "octocat");
      assert.equal(heldDeviceLink("octocat")?.userCode, "EARL-IER1", `${JSON.stringify(path)} replaced the earlier link`);
      values.set(KEY, JSON.stringify({ path, userCode: "ABCD-EFGH", login: "octocat" }));
      assert.equal(heldDeviceLink("octocat"), null, `${JSON.stringify(path)} is read back from storage`);
      assert.equal(values.has(KEY), false, `${JSON.stringify(path)} is left in storage`);
    });
  }
});

test("a link without an account is not held", () => {
  withStorage((values) => {
    holdDeviceLink("/connections?user_code=ABCD-EFGH", "");
    assert.equal(values.size, 0);
  });
});

test("a newer approval path replaces the one held before it", () => {
  withStorage(() => {
    holdDeviceLink("/connections?user_code=ABCD-EFGH", "octocat");
    holdDeviceLink("/connections?user_code=WXYZ-2345&return_to=setup", "octocat");
    assert.equal(heldDeviceLink("octocat")?.userCode, "WXYZ-2345");
  });
});

test("another account in the same tab gets nothing, and the link is forgotten", () => {
  withStorage((values) => {
    holdDeviceLink("/connections?user_code=ABCD-EFGH", "octocat");
    assert.equal(heldDeviceLink("hubot"), null);
    assert.equal(values.has(KEY), false);
    assert.equal(heldDeviceLink("octocat"), null, "switching back does not restore it");
  });
});

test("a stored value that isn't a held link is removed, whatever its shape", () => {
  for (const raw of [
    "not json",
    "null",
    "42",
    "[]",
    "{}",
    JSON.stringify({ path: "/connections?user_code=ABCD-EFGH" }),
    JSON.stringify({ login: "octocat" }),
    JSON.stringify({ path: 7, login: "octocat" }),
    JSON.stringify({ path: "/connections?user_code=ABCD-EFGH", login: "" }),
  ]) {
    withStorage((values) => {
      values.set(KEY, raw);
      assert.equal(heldDeviceLink("octocat"), null, raw);
      assert.equal(values.has(KEY), false, `${raw} is left in storage`);
    });
  }
});

test("the stored code is not trusted: reading and releasing both take it from the path", () => {
  withStorage((values) => {
    const planted = JSON.stringify({ path: "/connections?user_code=ABCD-EFGH", userCode: "OTHER-CODE", login: "octocat" });
    values.set(KEY, planted);
    assert.equal(heldDeviceLink("octocat")?.userCode, "ABCD-EFGH");
    releaseHeldDeviceLink("OTHER-CODE");
    assert.equal(values.get(KEY), planted, "an answer about the planted code doesn't release the path's code");
    releaseHeldDeviceLink("ABCD-EFGH");
    assert.equal(values.has(KEY), false);
  });
});

test("releasing a code forgets only that code", () => {
  withStorage((values) => {
    holdDeviceLink("/connections?user_code=ABCD-EFGH", "octocat");
    releaseHeldDeviceLink("WXYZ-2345");
    assert.equal(heldDeviceLink("octocat")?.userCode, "ABCD-EFGH", "an answer about an older code keeps the newer one");
    releaseHeldDeviceLink("abcd-efgh");
    assert.equal(values.has(KEY), false, "the same code in any case is released");
    assert.doesNotThrow(() => releaseHeldDeviceLink("ABCD-EFGH"), "releasing with nothing held");
    values.set(KEY, "not json");
    releaseHeldDeviceLink("ABCD-EFGH");
    assert.equal(values.has(KEY), false, "an unparseable value has nothing to protect");
  });
});

test("a browser that denies session storage loses the offer and nothing else", () => {
  withDeniedStorage(() => {
    assert.doesNotThrow(() => holdDeviceLink("/connections?user_code=ABCD-EFGH", "octocat"));
    assert.equal(heldDeviceLink("octocat"), null);
    assert.doesNotThrow(() => releaseHeldDeviceLink("ABCD-EFGH"));
  });
  withThrowingMethods(["getItem", "setItem", "removeItem"], () => {
    assert.doesNotThrow(() => holdDeviceLink("/connections?user_code=ABCD-EFGH", "octocat"));
    assert.equal(heldDeviceLink("octocat"), null);
    assert.doesNotThrow(() => releaseHeldDeviceLink("ABCD-EFGH"));
  });
  withThrowingMethods(["removeItem"], (values) => {
    values.set(KEY, JSON.stringify({ path: "/connections?user_code=ABCD-EFGH", login: "octocat" }));
    assert.equal(heldDeviceLink("hubot"), null, "a link that can't be removed is still not given to another account");
  });
});

test("the held link is not the sign-in return, so nothing navigates to it", () => {
  // Landing and SignInPage navigate to pendingReturn() and nothing else; the
  // held link has to stay out of it, or the dead-form loop comes back.
  withStorage((values) => {
    holdDeviceLink("/connections?user_code=ABCD-EFGH&return_to=setup", "octocat");
    assert.deepEqual([...values.keys()], [KEY]);
    assert.equal(pendingReturn(), null);
    clearPendingReturn();
    assert.equal(heldDeviceLink("octocat")?.userCode, "ABCD-EFGH", "clearing the sign-in return keeps the held link");
  });
});
