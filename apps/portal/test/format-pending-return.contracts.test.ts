import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDateTime,
  formatDurationMs,
  formatTimeAgo,
  firstName,
  greeting,
  runNumberLabel,
} from "../src/lib/format.ts";
import {
  clearConnectionReturn,
  isConnectionReturnPath,
  pendingConnectionReturn,
  rememberConnectionReturn,
} from "../src/lib/pending-return.ts";

// --- helpers -------------------------------------------------------------
// The pending-return module resolves the bare `sessionStorage` global, so the
// tests install stubs on globalThis and restore whatever was there before.

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function throwingStorage(): StorageLike {
  const deny = (): never => {
    throw new Error("SecurityError: storage is blocked (simulated private mode)");
  };
  return { getItem: deny, setItem: deny, removeItem: deny };
}

function withSessionStorage(stub: StorageLike | undefined, run: () => void): void {
  const globals = globalThis as { sessionStorage?: StorageLike };
  const original = globals.sessionStorage;
  globals.sessionStorage = stub;
  try {
    run();
  } finally {
    globals.sessionStorage = original;
  }
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function throwsNamingInput(fn: () => unknown, name: string, input: string): void {
  assert.throws(
    fn,
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(name) &&
      err.message.includes(input),
  );
}

// --- formatDurationMs ----------------------------------------------------

test("formatDurationMs pins the ms, seconds, and minutes boundaries", () => {
  assert.equal(formatDurationMs(0), "0 ms");
  assert.equal(formatDurationMs(999), "999 ms");
  assert.equal(formatDurationMs(1000), "1.0 s");
  // Seconds run to 90 s, so 59999 and 60000 both render as "60.0 s".
  assert.equal(formatDurationMs(59999), "60.0 s");
  assert.equal(formatDurationMs(60000), "60.0 s");
  assert.equal(formatDurationMs(89900), "89.9 s");
  assert.equal(formatDurationMs(90000), "1m 30s");
  assert.equal(formatDurationMs(7_200_000), "120m 00s");
});

test("formatDurationMs keeps negative and huge finite values as strings", () => {
  assert.equal(formatDurationMs(-2500), "-2500 ms");
  assert.equal(typeof formatDurationMs(Number.MAX_VALUE), "string");
});

test("formatDurationMs throws a specific error for non-finite durations", () => {
  throwsNamingInput(() => formatDurationMs(NaN), "formatDurationMs", "NaN");
  throwsNamingInput(
    () => formatDurationMs(Infinity),
    "formatDurationMs",
    "Infinity",
  );
  throwsNamingInput(
    () => formatDurationMs(-Infinity),
    "formatDurationMs",
    "-Infinity",
  );
});

// --- formatTimeAgo -------------------------------------------------------

test("formatTimeAgo pins the 45s, 60m, and 36h thresholds", () => {
  const now = Date.now();
  assert.equal(formatTimeAgo(now - 40_000), "just now");
  assert.equal(formatTimeAgo(now + MINUTE_MS), "just now");
  assert.equal(formatTimeAgo(now - 45_000), "1 min ago");
  assert.equal(formatTimeAgo(now - 59 * MINUTE_MS), "59 min ago");
  assert.equal(formatTimeAgo(now - 60 * MINUTE_MS), "1 h ago");
  assert.equal(formatTimeAgo(now - 35 * HOUR_MS), "35 h ago");
  assert.equal(formatTimeAgo(now - 36 * HOUR_MS), "2 d ago");
});

test("formatTimeAgo throws a specific error for non-finite epoch times", () => {
  throwsNamingInput(() => formatTimeAgo(NaN), "formatTimeAgo", "NaN");
  throwsNamingInput(
    () => formatTimeAgo(Infinity),
    "formatTimeAgo",
    "Infinity",
  );
});

// --- formatDateTime ------------------------------------------------------

test("formatDateTime throws for non-finite input and returns a string otherwise", () => {
  throwsNamingInput(() => formatDateTime(NaN), "formatDateTime", "NaN");
  throwsNamingInput(
    () => formatDateTime(-Infinity),
    "formatDateTime",
    "-Infinity",
  );
  const rendered = formatDateTime(0);
  assert.equal(typeof rendered, "string");
  assert.ok(rendered.length > 0);
});

// --- runNumberLabel, greeting, firstName --------------------------------

test("runNumberLabel uppercases the id tail for short and lowercase ids", () => {
  assert.equal(runNumberLabel("run-3f82"), "RUN 3F82");
  assert.equal(runNumberLabel("a1"), "RUN A1");
  assert.equal(runNumberLabel("abcd"), "RUN ABCD");
});

test("greeting pins the morning, afternoon, and evening boundaries", () => {
  assert.equal(greeting(0), "Good morning");
  assert.equal(greeting(11), "Good morning");
  assert.equal(greeting(12), "Good afternoon");
  assert.equal(greeting(17), "Good afternoon");
  assert.equal(greeting(18), "Good evening");
  assert.equal(greeting(23), "Good evening");
});

test("firstName pins the null, empty, and multi-space fallback behavior", () => {
  assert.equal(firstName("Ada Lovelace", "adalo"), "Ada");
  assert.equal(firstName(null, "adalo"), "adalo");
  assert.equal(firstName("", "adalo"), "adalo");
  assert.equal(firstName("Sam  Gu", "sgu"), "Sam");
  assert.equal(firstName("   ", "adalo"), "adalo");
});

// --- isConnectionReturnPath ---------------------------------------------

test("isConnectionReturnPath accepts exactly the two connection-entry prefixes", () => {
  assert.equal(isConnectionReturnPath("/connections#discord=abc123"), true);
  assert.equal(isConnectionReturnPath("/connections?user_code=XY-99"), true);
  // The check is a prefix check, so the bare prefixes with no value after
  // them still count; that is the current contract, pinned here.
  assert.equal(isConnectionReturnPath("/connections#discord="), true);
  assert.equal(isConnectionReturnPath("/connections?user_code="), true);
});

test("isConnectionReturnPath rejects everything that is not one of the two prefixes", () => {
  assert.equal(isConnectionReturnPath(""), false);
  assert.equal(isConnectionReturnPath("connections#discord=abc123"), false);
  assert.equal(isConnectionReturnPath("/connect"), false);
  assert.equal(isConnectionReturnPath("/connections"), false);
  assert.equal(isConnectionReturnPath("/connections#github=abc123"), false);
  assert.equal(isConnectionReturnPath("/connections?code=abc123"), false);
  assert.equal(isConnectionReturnPath("/dashboard"), false);
  assert.equal(
    isConnectionReturnPath("https://portal.example.com/connections#discord=abc123"),
    false,
  );
});

// --- pending-return: normal storage --------------------------------------

test("remember, pending, and clear round-trip through working storage", () => {
  withSessionStorage(memoryStorage(), () => {
    assert.equal(pendingConnectionReturn(), null);
    rememberConnectionReturn("/connections#discord=abc123");
    assert.equal(pendingConnectionReturn(), "/connections#discord=abc123");
    clearConnectionReturn();
    assert.equal(pendingConnectionReturn(), null);
  });
});

test("rememberConnectionReturn keeps the round-trip on the user_code prefix", () => {
  withSessionStorage(memoryStorage(), () => {
    rememberConnectionReturn("/connections?user_code=XY-99");
    assert.equal(pendingConnectionReturn(), "/connections?user_code=XY-99");
  });
});

test("rememberConnectionReturn ignores values that are not connection returns", () => {
  withSessionStorage(memoryStorage(), () => {
    rememberConnectionReturn("/dashboard");
    assert.equal(pendingConnectionReturn(), null);
  });
});

test("pendingConnectionReturn treats stored non-connection values as nothing pending", () => {
  const stub = memoryStorage();
  stub.setItem("cogportal.pendingReturn", "/dashboard");
  withSessionStorage(stub, () => {
    assert.equal(pendingConnectionReturn(), null);
  });
});

// --- pending-return: blocked or missing storage --------------------------

test("a throwing sessionStorage never propagates out of the pending-return helpers", () => {
  withSessionStorage(throwingStorage(), () => {
    assert.doesNotThrow(() =>
      rememberConnectionReturn("/connections#discord=abc123"),
    );
    assert.equal(pendingConnectionReturn(), null);
    assert.doesNotThrow(() => clearConnectionReturn());
  });
});

test("missing sessionStorage behaves like disabled persistence", () => {
  withSessionStorage(undefined, () => {
    assert.doesNotThrow(() =>
      rememberConnectionReturn("/connections?user_code=XY-99"),
    );
    assert.equal(pendingConnectionReturn(), null);
    assert.doesNotThrow(() => clearConnectionReturn());
  });
});
