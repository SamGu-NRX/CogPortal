import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSurfaceAction, RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import { terminalButtons, watchLiveAvailable } from "../src/policy.ts";

function snapshot(overrides: Partial<RunSurfaceSnapshot> = {}): RunSurfaceSnapshot {
  return {
    id: `surface_${"a".repeat(20)}`,
    team: { id: "team-1", name: "Analytical Engines" },
    benchmark: { id: "vision-recognition", version: 1, title: "Vision Recognition" },
    actor: { login: "ada", name: "Ada" },
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    branch: "main",
    dirty: false,
    stage: "local",
    status: "running",
    phase: "evaluating",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_008_000,
    finishedAt: null,
    elapsedMs: 8_000,
    progress: { current: 18, total: 40, unit: "cases" },
    primaryMetric: null,
    metrics: [],
    teamBest: null,
    localRunId: "run_1",
    practiceRunId: null,
    officialRunId: null,
    published: false,
    nextOfficialAttempt: 2,
    events: [],
    actions: ["open_console", "open_portal"],
    simulated: true,
    ...overrides,
  };
}

function labels(actions: RunSurfaceAction[]): string[] {
  return terminalButtons(snapshot({ status: "succeeded", actions })).map((spec) => spec.label);
}

test("terminalButtons refuses a running snapshot", () => {
  assert.throws(
    () => terminalButtons(snapshot({ status: "running", actions: ["verify_hosted"] })),
    (error: unknown) => {
      assert.ok(error instanceof TypeError, `expected TypeError, got ${String(error)}`);
      assert.match(
        error.message,
        /^terminalButtons: snapshot is not terminal \(status "running"\); render buttons only for terminal snapshots\.$/,
      );
      return true;
    },
  );
});

test("every terminal status may render buttons, only running is refused", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const buttons = terminalButtons(snapshot({ status, actions: ["publish_result", "rerun_hosted"] }));
    assert.deepEqual(buttons.map((spec) => spec.label), ["Publish result", "Rerun hosted"], `status ${status}`);
  }
});

test("primary precedence is publish_result, then promote_official, then verify_hosted", () => {
  const cases: Array<[RunSurfaceAction[], string]> = [
    [["promote_official", "publish_result"], "Publish result"],
    [["verify_hosted", "publish_result"], "Publish result"],
    [["publish_result", "promote_official"], "Publish result"],
    [["verify_hosted", "promote_official"], "Promote to official"],
    [["promote_official", "verify_hosted"], "Promote to official"],
    [["publish_result", "verify_hosted"], "Publish result"],
    [["verify_hosted", "promote_official", "publish_result"], "Publish result"],
    [["promote_official", "verify_hosted", "publish_result"], "Publish result"],
    [["publish_result", "promote_official", "verify_hosted"], "Publish result"],
  ];
  for (const [actions, expected] of cases) {
    const buttons = terminalButtons(snapshot({ status: "succeeded", actions }));
    assert.deepEqual(
      buttons.map((spec) => [spec.label, spec.style]),
      [[expected, 1]],
      `actions ${actions.join(", ")}`,
    );
  }
});

test("secondary precedence is rerun_hosted over run_again", () => {
  const cases: Array<[RunSurfaceAction[], string]> = [
    [["run_again", "rerun_hosted"], "Rerun hosted"],
    [["rerun_hosted", "run_again"], "Rerun hosted"],
  ];
  for (const [actions, expected] of cases) {
    const buttons = terminalButtons(snapshot({ status: "succeeded", actions }));
    assert.deepEqual(
      buttons.map((spec) => [spec.label, spec.style]),
      [[expected, 2]],
      `actions ${actions.join(", ")}`,
    );
  }
});

test("a primary and a secondary render together, primary first", () => {
  const cases: Array<[RunSurfaceAction[], Array<[string, number]>]> = [
    [["run_again", "verify_hosted"], [["Verify hosted", 1], ["Run again", 2]]],
    [["publish_result", "rerun_hosted"], [["Publish result", 1], ["Rerun hosted", 2]]],
    [["rerun_hosted", "run_again", "promote_official"], [["Promote to official", 1], ["Rerun hosted", 2]]],
    [["open_console", "open_portal", "run_again", "publish_result"], [["Publish result", 1], ["Run again", 2]]],
  ];
  for (const [actions, expected] of cases) {
    assert.deepEqual(
      terminalButtons(snapshot({ status: "succeeded", actions })).map((spec) => [spec.label, spec.style]),
      expected,
      `actions ${actions.join(", ")}`,
    );
  }
});

test("only open_console and open_portal available means no buttons at terminal", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    assert.deepEqual(
      terminalButtons(snapshot({ status, actions: ["open_console", "open_portal"] })),
      [],
      `status ${status}`,
    );
  }
});

test("duplicate action entries in the snapshot do not duplicate buttons", () => {
  const buttons = terminalButtons(
    snapshot({ status: "succeeded", actions: ["publish_result", "publish_result", "rerun_hosted", "rerun_hosted"] }),
  );
  assert.deepEqual(
    buttons.map((spec) => [spec.label, spec.style]),
    [["Publish result", 1], ["Rerun hosted", 2]],
  );
});

test("labels are exact for every action the policy can render", () => {
  const cases: Array<[RunSurfaceAction, string]> = [
    ["publish_result", "Publish result"],
    ["promote_official", "Promote to official"],
    ["verify_hosted", "Verify hosted"],
    ["rerun_hosted", "Rerun hosted"],
    ["run_again", "Run again"],
  ];
  for (const [action, expected] of cases) {
    assert.deepEqual(labels([action]), [expected], `action ${action}`);
  }
});

test("styles are exact: one primary (1) and one secondary (2)", () => {
  const buttons = terminalButtons(
    snapshot({ status: "succeeded", actions: ["promote_official", "run_again"] }),
  );
  assert.deepEqual(buttons.map((spec) => spec.style), [1, 2]);
});

test("watchLiveAvailable is true only while running with open_console", () => {
  const cases: Array<[RunSurfaceSnapshot["status"], RunSurfaceAction[], boolean]> = [
    ["running", ["open_console"], true],
    ["running", ["open_console", "open_portal"], true],
    ["running", ["open_portal"], false],
    ["running", [], false],
    ["succeeded", ["open_console"], false],
    ["failed", ["open_console"], false],
    ["cancelled", ["open_console"], false],
  ];
  for (const [status, actions, expected] of cases) {
    assert.equal(
      watchLiveAvailable(snapshot({ status, actions })),
      expected,
      `status ${status}, actions ${actions.join(", ") || "none"}`,
    );
  }
});
