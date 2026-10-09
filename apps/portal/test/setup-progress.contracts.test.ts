import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseChecks,
  reconcileChecks,
  setupSteps,
} from "../src/lib/setup-progress.ts";

const ALL_MACHINE_STEPS = ["clone", "environment", "project", "wiring"];

test("parseChecks reads null and empty storage as no checks", () => {
  assert.equal(parseChecks(null).size, 0);
  assert.equal(parseChecks("").size, 0);
});

test("parseChecks reads an empty JSON array as no checks", () => {
  const parsed = parseChecks("[]");
  assert.equal(parsed.size, 0);
});

test("parseChecks keeps the string ids of a stored array", () => {
  const parsed = parseChecks(JSON.stringify(["clone", "wiring"]));
  assert.equal(parsed.size, 2);
  assert.ok(parsed.has("clone"));
  assert.ok(parsed.has("wiring"));
});

test("parseChecks keeps only the strings of a mixed-type array", () => {
  const parsed = parseChecks(
    '["clone", 7, null, true, {"step": "clone"}, ["clone"], "wiring"]',
  );
  assert.deepEqual(parsed, new Set(["clone", "wiring"]));
});

test("parseChecks treats non-array JSON as no checks", () => {
  assert.equal(parseChecks('{"clone": true}').size, 0);
  assert.equal(parseChecks("42").size, 0);
  assert.equal(parseChecks('"clone"').size, 0);
  assert.equal(parseChecks("true").size, 0);
  assert.equal(parseChecks("null").size, 0);
});

test("parseChecks treats malformed JSON as no checks", () => {
  assert.equal(parseChecks('{"clone').size, 0);
  assert.equal(parseChecks("[clone, wiring]").size, 0);
});

test("parseChecks collapses duplicate step ids", () => {
  const parsed = parseChecks('["clone", "clone", "clone", "wiring"]');
  assert.deepEqual(parsed, new Set(["clone", "wiring"]));
});

test("parseChecks keeps unicode step ids as written", () => {
  const ids = ["clönen", "wırıng-✓", "😀-setup"];
  const parsed = parseChecks(JSON.stringify(ids));
  assert.deepEqual(parsed, new Set(ids));
});

test("parseChecks survives a 5000-element stored array", () => {
  const stored = Array.from({ length: 5000 }, (_, i) =>
    i % 2 === 0 ? 7 : `step-${i % 300}`,
  );
  const parsed = parseChecks(JSON.stringify(stored));
  const expected = new Set(
    stored.filter((v): v is string => typeof v === "string"),
  );
  assert.deepEqual(parsed, expected);
});

test("reconcile reuses the cached checks while the storage key matches", () => {
  const cache = { key: "cog-setup:team-a:sam", checks: new Set(["clone"]) };
  let reads = 0;
  const current = reconcileChecks(cache, "cog-setup:team-a:sam", () => {
    reads += 1;
    return new Set<string>();
  });
  assert.equal(current, cache);
  assert.equal(reads, 0);
});

test("reconcile re-reads and drops stale checks when the storage key changes", () => {
  // Regression: the setup guide stays mounted while the student switches
  // teams, and the hook used to keep showing the previous team's ticks.
  const stale = {
    key: "cog-setup:team-a:sam",
    checks: new Set(["teammates"]),
  };
  const current = reconcileChecks(stale, "cog-setup:team-b:sam", (key) => {
    assert.equal(key, "cog-setup:team-b:sam");
    return new Set(["clone"]);
  });
  assert.notEqual(current, stale);
  assert.equal(current.key, "cog-setup:team-b:sam");
  assert.deepEqual(current.checks, new Set(["clone"]));
});

test("created entry counts verified teammates or the browser self-check", () => {
  assert.deepEqual(setupSteps("created", new Set(), { teammates: true }), {
    done: 2,
    total: 6,
  });
  assert.deepEqual(
    setupSteps("created", new Set(["teammates"]), { teammates: false }),
    { done: 2, total: 6 },
  );
  assert.deepEqual(setupSteps("created", new Set(), { teammates: false }), {
    done: 1,
    total: 6,
  });
  assert.deepEqual(
    setupSteps("created", new Set(["teammates"]), {
      teammates: true,
      terminal: ALL_MACHINE_STEPS,
    }),
    { done: 6, total: 6 },
  );
});

test("joined entry never counts teammates", () => {
  // Teammate signals change nothing in the joined entry: both lead states are
  // unconditionally done, with or without them.
  const withoutTeammates = setupSteps("joined", new Set(), { teammates: false });
  assert.deepEqual(withoutTeammates, { done: 2, total: 6 });
  assert.deepEqual(
    setupSteps("joined", new Set(["teammates"]), { teammates: true }),
    withoutTeammates,
  );
  assert.deepEqual(
    setupSteps("joined", new Set(["teammates"]), {
      teammates: true,
      terminal: ALL_MACHINE_STEPS,
    }),
    { done: 6, total: 6 },
  );
});

test("browser check marks never count machine steps", () => {
  // Only the teammates self-check is a browser fact; the four machine steps
  // ignore browser marks entirely, so the full set adds exactly one step.
  const machineOnly = new Set(ALL_MACHINE_STEPS);
  assert.deepEqual(
    setupSteps("created", machineOnly, { teammates: false }),
    { done: 1, total: 6 },
  );
  const browserChecked = new Set([...ALL_MACHINE_STEPS, "teammates"]);
  assert.deepEqual(
    setupSteps("created", browserChecked, { teammates: false }),
    { done: 2, total: 6 },
  );
  assert.deepEqual(
    setupSteps("created", browserChecked, { teammates: false, terminal: [] }),
    { done: 2, total: 6 },
  );
});

test("terminal evidence counts the machine steps it verified", () => {
  assert.deepEqual(
    setupSteps("created", new Set(), {
      teammates: true,
      terminal: ALL_MACHINE_STEPS,
    }),
    { done: 6, total: 6 },
  );
  assert.deepEqual(
    setupSteps("created", new Set(), { teammates: true, terminal: ["clone"] }),
    { done: 3, total: 6 },
  );
});

test("terminal absent and terminal empty read the same", () => {
  const absent = setupSteps("created", new Set(), { teammates: true });
  const empty = setupSteps("created", new Set(), {
    teammates: true,
    terminal: [],
  });
  assert.deepEqual(absent, empty);
  assert.deepEqual(absent, { done: 2, total: 6 });
});

test("partial terminal evidence counts only the verified machine steps", () => {
  assert.deepEqual(
    setupSteps("created", new Set(), {
      teammates: true,
      terminal: ["clone", "wiring"],
    }),
    { done: 4, total: 6 },
  );
});

test("unknown step ids in checks and terminal are ignored", () => {
  assert.deepEqual(
    setupSteps("created", new Set(["teammates", "nonsense-check"]), {
      teammates: true,
      terminal: ["nonsense", "clone"],
    }),
    { done: 3, total: 6 },
  );
});
