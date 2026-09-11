import assert from "node:assert/strict";
import test from "node:test";
import { RunSurfaceSnapshotSchema, shouldReplaceRunSurfaceSnapshot, type RunSurfaceSnapshot } from "@cogworks/contracts/schema";

function snapshot(revision: number, generation = 1): RunSurfaceSnapshot {
  return RunSurfaceSnapshotSchema.parse({
    id: "surface_0123456789abcdef0123",
    team: { id: "team_test", name: "Test team" },
    benchmark: { id: "vision-recognition", version: 1, title: "Vision Recognition" },
    actor: { login: "ada", name: "Ada" },
    sha: "a".repeat(40), shortSha: "aaaaaaa", branch: "main", dirty: false,
    stage: "hosted", status: "running", phase: "queued",
    createdAt: 1_780_000_000_000, updatedAt: 1_780_000_001_000,
    finishedAt: null, elapsedMs: 1_000, progress: null, primaryMetric: null,
    localRunId: null, practiceRunId: `run_generation_${generation}`, officialRunId: null,
    executionGeneration: generation, snapshotRevision: revision,
    published: false, nextOfficialAttempt: null, events: [], actions: ["open_portal"], simulated: true,
  });
}

test("delayed queued HTTP response cannot replace same-time evaluating socket frame", () => {
  const queued = snapshot(1);
  const evaluating = { ...snapshot(2), phase: "evaluating" };
  assert.equal(shouldReplaceRunSurfaceSnapshot(queued, evaluating), true);
  assert.equal(shouldReplaceRunSurfaceSnapshot(evaluating, queued), false);
  assert.equal(shouldReplaceRunSurfaceSnapshot(evaluating, evaluating), false);
  assert.equal(shouldReplaceRunSurfaceSnapshot(evaluating, { ...queued, updatedAt: queued.updatedAt + 10_000 }), false);
});

test("publication false to true to false follows revisions, not timestamps", () => {
  const before = { ...snapshot(1), status: "succeeded" as const };
  const published = { ...before, snapshotRevision: 2, published: true };
  const deselected = { ...before, snapshotRevision: 3 };
  assert.equal(shouldReplaceRunSurfaceSnapshot(before, published), true);
  assert.equal(shouldReplaceRunSurfaceSnapshot(published, deselected), true);
  assert.equal(shouldReplaceRunSurfaceSnapshot(deselected, published), false);
});

test("generation outranks revision and terminal regression remains forbidden", () => {
  const current = snapshot(2, 2);
  assert.equal(shouldReplaceRunSurfaceSnapshot(current, snapshot(100, 1)), false);
  assert.equal(shouldReplaceRunSurfaceSnapshot(snapshot(100, 1), current), true);
  const terminal = { ...current, status: "failed" as const };
  assert.equal(shouldReplaceRunSurfaceSnapshot(terminal, snapshot(3, 2)), false);
  assert.equal(shouldReplaceRunSurfaceSnapshot(terminal, { ...terminal, snapshotRevision: 3, refusalHeadline: "Later finding" }), true);
});

test("wrong-console frames are rejected even with a higher revision and generation", () => {
  assert.equal(shouldReplaceRunSurfaceSnapshot(snapshot(1), {
    ...snapshot(100, 100), id: "surface_aaaaaaaaaaaaaaaaaaaa",
  }), false);
});

test("legacy cached payloads decode at revision zero and yield to numbered payloads", () => {
  const { snapshotRevision: _, ...legacy } = snapshot(1);
  const parsed = RunSurfaceSnapshotSchema.parse(legacy);
  assert.equal(parsed.snapshotRevision, 0);
  assert.equal(shouldReplaceRunSurfaceSnapshot(parsed, snapshot(1)), true);
  assert.equal(shouldReplaceRunSurfaceSnapshot(snapshot(1), parsed), false);
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(RunSurfaceSnapshotSchema.safeParse({ ...legacy, snapshotRevision: invalid }).success, false);
  }
});
