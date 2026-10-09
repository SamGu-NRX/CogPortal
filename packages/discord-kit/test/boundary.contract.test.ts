import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStreamEvent, RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import {
  parseRunStreamEvents,
  parseRunSurfaceSnapshot,
  safeParseRunSurfaceSnapshot,
} from "../src/boundary.ts";

// Mirror of the pinned fixtures in test/loader.test.ts.
function event(overrides: Partial<RunStreamEvent> = {}): RunStreamEvent {
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

test("parseRunSurfaceSnapshot returns the parsed snapshot for a valid payload", () => {
  const fixture = snapshot();
  assert.deepEqual(parseRunSurfaceSnapshot(fixture), fixture);
});

test("parseRunSurfaceSnapshot accepts null nullable fields and empty actions and events", () => {
  const boundaryCase: Record<string, unknown> = {
    ...snapshot(),
    actor: { login: "ada", name: null },
    branch: null,
    finishedAt: null,
    progress: null,
    primaryMetric: null,
    teamBest: null,
    localRunId: null,
    practiceRunId: null,
    officialRunId: null,
    nextOfficialAttempt: null,
    events: [],
    actions: [],
  };
  assert.deepEqual(parseRunSurfaceSnapshot(boundaryCase), boundaryCase);
});

test("parseRunSurfaceSnapshot accepts exactly 250 events and rejects 251", () => {
  const events = (count: number): RunStreamEvent[] =>
    Array.from({ length: count }, (_, index) => event({ eventId: `event_${String(index).padStart(6, "0")}_pad` }));

  const atCap: Record<string, unknown> = { ...snapshot(), events: events(250) };
  assert.deepEqual(parseRunSurfaceSnapshot(atCap), atCap);

  const overCap: Record<string, unknown> = { ...snapshot(), events: events(251) };
  assert.throws(
    () => parseRunSurfaceSnapshot(overCap),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): events: Too big: expected array to have <=250 items$/.test(
        error.message,
      ),
  );
});

test("parseRunSurfaceSnapshot rejects a missing required field and names the path", () => {
  const missingId: Record<string, unknown> = { ...snapshot() };
  delete missingId.id;
  assert.throws(
    () => parseRunSurfaceSnapshot(missingId),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): id: Invalid input: expected string, received undefined$/.test(
        error.message,
      ),
  );
});

test("parseRunSurfaceSnapshot rejects a string where the actions array belongs", () => {
  const actionsAsString: Record<string, unknown> = { ...snapshot(), actions: "nope" };
  assert.throws(
    () => parseRunSurfaceSnapshot(actionsAsString),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): actions: Invalid input: expected array, received string$/.test(
        error.message,
      ),
  );
});

test("parseRunSurfaceSnapshot rejects an unknown action value and names the path", () => {
  const unknownAction: Record<string, unknown> = { ...snapshot(), actions: ["nope"] };
  assert.throws(
    () => parseRunSurfaceSnapshot(unknownAction),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): actions\.0: Invalid option: expected one of "open_console"\|"open_portal"\|"verify_hosted"\|"run_again"\|"promote_official"\|"rerun_hosted"\|"publish_result"$/.test(
        error.message,
      ),
  );
});

test("parseRunSurfaceSnapshot rejects a number where a string field belongs", () => {
  const shortShaNumber: Record<string, unknown> = { ...snapshot(), shortSha: 123 };
  assert.throws(
    () => parseRunSurfaceSnapshot(shortShaNumber),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): shortSha: Invalid input: expected string, received number$/.test(
        error.message,
      ),
  );
});

// Pinned behavior: zod v4 rejects NaN at the type level, before the int and
// nonnegative checks run, so NaN cannot pass through a z.number() field.
// This test makes a zod upgrade that lets NaN through fail loudly here.
test("parseRunSurfaceSnapshot rejects NaN for a number field", () => {
  const nanElapsed: Record<string, unknown> = { ...snapshot(), elapsedMs: Number.NaN };
  assert.throws(
    () => parseRunSurfaceSnapshot(nanElapsed),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): elapsedMs: Invalid input: expected number, received NaN$/.test(
        error.message,
      ),
  );
});

test("safeParseRunSurfaceSnapshot returns ok true with the parsed value", () => {
  const fixture = snapshot();
  assert.deepEqual(safeParseRunSurfaceSnapshot(fixture), { ok: true, value: fixture });
});

test("safeParseRunSurfaceSnapshot reports the same message the throwing parser throws", () => {
  const missingId: Record<string, unknown> = { ...snapshot() };
  delete missingId.id;
  const safe = safeParseRunSurfaceSnapshot(missingId);
  if (safe.ok) {
    assert.fail("expected the safe parser to reject the payload");
  }
  let thrownMessage = "";
  try {
    parseRunSurfaceSnapshot(missingId);
  } catch (error) {
    assert.ok(error instanceof TypeError);
    thrownMessage = error.message;
  }
  assert.match(safe.message, /^RunSurfaceSnapshot failed contract validation \(Portal RPC response\): id: /);
  assert.equal(safe.message, thrownMessage);
});

test("parseRunStreamEvents returns the parsed events for a valid array", () => {
  const fixture = [event(), event({ code: "run.completed", phase: "complete", elapsedMs: 8_000 })];
  assert.deepEqual(parseRunStreamEvents(fixture), fixture);
});

test("parseRunStreamEvents rejects a non-array payload", () => {
  assert.throws(
    () => parseRunStreamEvents("nope"),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunStreamEvent\[\] failed contract validation \(Portal RPC response\): \(root\): Invalid input: expected array, received string$/.test(
        error.message,
      ),
  );
});

// The empty element produces nine issues; only the first three are rendered.
test("parseRunStreamEvents renders at most three issues for a malformed element", () => {
  const oneGoodOneEmpty: unknown = [event(), {}];
  assert.throws(
    () => parseRunStreamEvents(oneGoodOneEmpty),
    (error: unknown): error is TypeError =>
      error instanceof TypeError
      && /^RunStreamEvent\[\] failed contract validation \(Portal RPC response\): 1\.eventId: Invalid input: expected string, received undefined; 1\.source: Invalid option: expected one of "local"\|"practice"\|"official"\|"system"; 1\.sourceRunId: Invalid input: expected string, received undefined$/.test(
        error.message,
      ),
  );
});
