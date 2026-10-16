// Regression tests for the two Codex review findings on PR #127:
//   1. provider-journal URLs must derive from the configured DOUBLES_BASE
//      (not the hard-coded 8811/8813/8814), with the documented default
//      instead of a silent skip, and an explicit `off` to skip;
//   2. the walker must poll /api/runs for a newly started run until it
//      appears, instead of sleeping 1.5 s and trusting one fetch.
// Run: node --test tools/portal-real-journeys/journeys/burst11-student/
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DOUBLES_BASE, doublesJournals, pollForRuns } from "./journey-support.mjs";

test("journal URLs default to the documented doubles base", () => {
  const journals = doublesJournals(undefined);
  assert.deepEqual(
    journals.map((j) => j.journal),
    [
      "http://127.0.0.1:8811/__doubles/journal",
      "http://127.0.0.1:8813/__doubles/journal",
      "http://127.0.0.1:8814/__doubles/journal",
    ],
  );
  assert.deepEqual(
    journals.map((j) => j.name),
    ["github-rest", "discord", "modal-runner"],
  );
  assert.equal(DEFAULT_DOUBLES_BASE, "http://127.0.0.1:8811");
});

test("journal URLs derive from a non-default DOUBLES_BASE", () => {
  const journals = doublesJournals("http://127.0.0.1:9100");
  assert.deepEqual(
    journals.map((j) => j.journal),
    [
      "http://127.0.0.1:9100/__doubles/journal",
      "http://127.0.0.1:9102/__doubles/journal",
      "http://127.0.0.1:9103/__doubles/journal",
    ],
  );
});

test("journal URLs keep host and scheme from DOUBLES_BASE", () => {
  const journals = doublesJournals("http://localhost:9100/");
  assert.ok(journals[1].journal.startsWith("http://localhost:9102/"));
});

test("DOUBLES_BASE=off skips the journal check", () => {
  assert.equal(doublesJournals("off"), null);
  assert.equal(doublesJournals(" OFF "), null);
});

test("empty DOUBLES_BASE falls back to the documented default, not a silent skip", () => {
  const journals = doublesJournals("");
  assert.equal(journals[0].journal, "http://127.0.0.1:8811/__doubles/journal");
});

test("pollForRuns waits until /api/runs lists the new run", async () => {
  let calls = 0;
  const found = await pollForRuns(
    async () => {
      calls += 1;
      return calls < 3 ? [] : [{ id: "run_9", mode: "practice", branch: "main" }];
    },
    (r) => r.mode === "practice" && r.branch === "main",
    { deadlineMs: 5_000, intervalMs: 1, label: "the new practice run" },
  );
  assert.equal(found.id, "run_9");
  assert.ok(calls >= 3, `polled ${calls} times`);
});

test("pollForRuns only accepts a run matching the predicate", async () => {
  const found = await pollForRuns(
    async () => [
      { id: "run_old", mode: "practice", branch: "stale" },
      { id: "run_new", mode: "practice", branch: "main" },
    ],
    (r) => r.mode === "practice" && r.branch === "main",
    { deadlineMs: 1_000, intervalMs: 1, label: "the new practice run" },
  );
  assert.equal(found.id, "run_new");
});

test("pollForRuns throws naming the run when it never appears", async () => {
  await assert.rejects(
    pollForRuns(async () => [], () => true, {
      deadlineMs: 50,
      intervalMs: 1,
      label: "the new practice run on main",
    }),
    /the new practice run on main/,
  );
});
