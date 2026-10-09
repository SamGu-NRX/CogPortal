import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStreamEvent, RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import { emojiFormatter } from "../src/emoji.ts";
import { terminalButtons, watchLiveAvailable } from "../src/policy.ts";
import { stageRail } from "../src/rails.ts";
import { effectivePhase, failureTrace, loaderLine, loaderSteps } from "../src/steps.ts";

const fmt = emojiFormatter(undefined, {});

function event(overrides: Partial<RunStreamEvent>): RunStreamEvent {
  return {
    eventId: "stream_event_x",
    source: "local",
    sourceRunId: "run_1",
    sourceSequence: 0,
    phase: "evaluating",
    code: "evaluation.progress",
    occurredAt: 1_750_000_000_000,
    elapsedMs: 2_000,
    progress: null,
    ...overrides,
  };
}

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

test("loader marks past steps done, the current step active, and the rest dimmed", () => {
  const steps = loaderSteps(snapshot(), [
    event({ code: "contract.checking", phase: "contract_check", elapsedMs: 2_000 }),
    event({ code: "evaluation.started", phase: "evaluating", elapsedMs: 6_000 }),
  ]);
  assert.deepEqual(steps.map((step) => step.state), ["done", "done", "active", "pending"]);
  assert.equal(steps[0]!.chip, "`0:02`");
  assert.equal(steps[1]!.chip, "`0:06`");
  assert.equal(steps[2]!.chip, "`18/40`");
  const lines = steps.map((step) => loaderLine(step, fmt));
  assert.match(lines[2]!, /\*\*Evaluating\*\*/);
  assert.equal(lines[3], "-# Scoring");
});

test("missing boundary events omit time chips rather than inventing them", () => {
  const steps = loaderSteps(snapshot(), []);
  assert.equal(steps[0]!.chip, undefined);
  assert.equal(steps[1]!.chip, undefined);
});

test("effectivePhase falls back to observed events when phase holds a status word", () => {
  const terminal = snapshot({ status: "failed", phase: "failed" });
  assert.equal(effectivePhase(terminal, [event({ phase: "contract_check" })]), "contract_check");
  assert.equal(effectivePhase(terminal, []), null);
  assert.equal(effectivePhase(snapshot(), []), "evaluating");
});

test("failure trace shows the last good step plus the safe failure category", () => {
  const terminal = snapshot({ status: "failed", phase: "failed" });
  const lines = failureTrace(
    terminal,
    [
      event({ code: "contract.passed", phase: "contract_check", elapsedMs: 4_000 }),
      event({ code: "run.failed.timeout", phase: "evaluating", elapsedMs: 60_000 }),
    ],
    (code) => (code === "run.failed.timeout" ? "Evaluation timed out" : undefined),
    fmt,
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Contract passed/);
  assert.match(lines[1]!, /× Evaluation timed out {2}`1:00`/);
});

test("rail carries stage provenance and cancelled stays unclaimed", () => {
  assert.equal(
    stageRail(snapshot({ stage: "hosted" }), fmt),
    "✓ local  ● hosted  ○ official  ○ published",
  );
  assert.equal(
    stageRail(snapshot({ stage: "hosted" }), fmt, "subtext"),
    "-# ✓ local  ● hosted  ○ official  ○ published",
  );
  assert.match(stageRail(snapshot({ status: "cancelled", phase: "cancelled" }), fmt), /○ local/);
  assert.match(stageRail(snapshot({ stage: "published", status: "succeeded", published: true }), fmt), /✓ published/);
});

test("button policy: nothing while running, primary-first at terminal", () => {
  assert.equal(watchLiveAvailable(snapshot()), true);
  assert.equal(watchLiveAvailable(snapshot({ status: "succeeded" })), false);
  const terminal = snapshot({
    status: "succeeded",
    actions: ["run_again", "verify_hosted", "open_console", "open_portal"],
  });
  assert.deepEqual(
    terminalButtons(terminal).map((spec) => [spec.label, spec.style]),
    [["Verify hosted", 1], ["Run again", 2]],
  );
  assert.deepEqual(terminalButtons(snapshot({ status: "failed", actions: ["run_again"] })).map((spec) => spec.label), [
    "Run again",
  ]);
});

test("every known phase drives its loader step through snapshot.phase alone", () => {
  // One entry per phase KNOWN_PHASES recognizes in src/steps.ts; effectivePhase
  // trusts the snapshot column before scanning events, so the active step moves
  // with the phase and no events are needed.
  const phaseToStates: Record<string, string[]> = {
    queued: ["active", "pending", "pending", "pending"],
    preparing: ["active", "pending", "pending", "pending"],
    installing: ["active", "pending", "pending", "pending"],
    contract_check: ["done", "active", "pending", "pending"],
    evaluating: ["done", "done", "active", "pending"],
    scoring: ["done", "done", "done", "active"],
  };
  const phaseToActiveLabel: Record<string, string> = {
    queued: "Preparing the bench",
    preparing: "Preparing the bench",
    installing: "Preparing the bench",
    contract_check: "Checking the contract",
    evaluating: "Evaluating",
    scoring: "Reading the gauges",
  };
  for (const [phase, states] of Object.entries(phaseToStates)) {
    const steps = loaderSteps(snapshot({ phase }), []);
    assert.deepEqual(steps.map((step) => step.state), states, phase);
    const active = steps.find((step) => step.state === "active");
    assert.equal(active?.label, phaseToActiveLabel[phase], phase);
  }
});

test("stage rail marks local and official as the active stage", () => {
  assert.equal(
    stageRail(snapshot({ stage: "local" }), fmt),
    "● local\u2002\u2002○ hosted\u2002\u2002○ official\u2002\u2002○ published",
  );
  assert.equal(
    stageRail(snapshot({ stage: "official" }), fmt),
    "✓ local\u2002\u2002✓ hosted\u2002\u2002● official\u2002\u2002○ published",
  );
});

test("terminal buttons render a single primary when only publish_result exists", () => {
  assert.deepEqual(
    terminalButtons(snapshot({ status: "succeeded", actions: ["publish_result"] })),
    [{ action: "publish_result", label: "Publish result", style: 1 }],
  );
});

test("failure trace renders one line when no step finished", () => {
  const terminal = snapshot({ status: "failed", phase: "failed" });
  // Without events nothing is done, so there is no last-good line to cite and
  // the trace is the failure line alone, labelled from the failed step.
  const bare = failureTrace(terminal, [], () => undefined, fmt);
  assert.equal(bare.length, 1);
  assert.equal(bare[0], "× Preparing the bench");
  // A run.failed event still supplies the safe copy and its elapsed chip.
  const withEvent = failureTrace(
    terminal,
    [event({ code: "run.failed.timeout", phase: "preparing", elapsedMs: 5_000 })],
    (code) => (code === "run.failed.timeout" ? "Preparation failed" : undefined),
    fmt,
  );
  assert.equal(withEvent.length, 1);
  assert.equal(withEvent[0], "× Preparation failed  `0:05`");
});
