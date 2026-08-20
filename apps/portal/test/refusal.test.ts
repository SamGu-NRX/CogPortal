import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { RunEventV1Schema } from "@cogworks/contracts/protocol";
import { RunDetailSchema } from "@cogworks/contracts/schema";

/**
 * A run can fail because a team's algorithm crashed, which has a traceback and
 * belongs in the log, or because nothing in the repository performed the
 * week's task, which has no traceback at all. The second used to reach a
 * student as one capped line naming our own sandbox script.
 */

const refusal = {
  status: "not_wired",
  headline:
    "Nothing in your repository took a tuple of 2, starting with an array of shape (1025, 171) for the fingerprints step, which is what audio_parser.spectrogram_conversion returned.",
  nextStep:
    "fingerprint_database and fingerprint_maker did not import, because ipynb is not installed here.",
  trace: [{ stage: "spectrogram", function: "audio_parser.spectrogram_conversion" }],
};

test("a failed event may carry the whole verdict, not only a capped line", () => {
  const event = {
    protocolVersion: "1",
    eventId: "event_1",
    runId: "run_1",
    sequence: 1,
    occurredAt: 1,
    type: "failed",
    failure: {
      category: "adapter_missing",
      phase: "contract_check",
      detail: "No adapter found in their-repo.",
      infrastructure: false,
      refusal,
    },
  };

  const parsed = RunEventV1Schema.safeParse(event);
  assert.equal(parsed.success, true);
});

test("an older runner that sends no refusal is still valid", () => {
  const event = {
    protocolVersion: "1",
    eventId: "event_1",
    runId: "run_1",
    sequence: 1,
    occurredAt: 1,
    type: "failed",
    failure: {
      category: "timeout",
      phase: "evaluating",
      detail: "Timed out.",
      infrastructure: false,
    },
  };

  assert.equal(RunEventV1Schema.safeParse(event).success, true);
});

test("a run detail without a refusal reads as null rather than absent", () => {
  const parsed = RunDetailSchema.shape.refusal.safeParse(undefined);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data, null);
});

test("the headline is allowed to be longer than a log line", () => {
  // The old cap was 240 characters, which cut a refusal mid-sentence right
  // where it started naming the modules that could not be read.
  assert.ok(refusal.headline.length > 140);
  assert.equal(RunDetailSchema.shape.refusal.safeParse(refusal).success, true);
});

test("the adapter failure no longer tells a team to write packaging metadata", () => {
  // Zero of the thirteen 2026 capstones has a pyproject.toml, and the
  // platform no longer needs one. Sending a team to write an entry point
  // would cost them an afternoon on the wrong problem.
  const copy = FAILURE_CATALOG.adapter_missing;

  assert.ok(!copy.action.includes("pyproject.toml"));
  assert.ok(!copy.action.includes("entry-points"));
  assert.ok(copy.reproCommand.includes("cogworks check"));
});
