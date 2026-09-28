import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SetupEvidenceRequestSchema,
  SetupStateSchema,
  type Benchmark,
  type SetupStep,
} from "@cogworks/contracts/schema";
import {
  setupCommandProgress,
  setupCommandsForTeam,
} from "../src/lib/setup-progress.ts";

const validEvidence = {
  schemaVersion: 1,
  repositoryFullName: "CogWorksBWSI/team-project",
  checks: ["clone", "environment", "project", "wiring"],
  cliVersion: "0.1.0",
  pythonVersion: "3.11.9",
  benchmarkIds: ["vision-recognition", "vision-clustering"],
  submissionIds: ["vision-recognition", "vision-clustering"],
};

test("setup evidence accepts only the coarse documented payload", () => {
  assert.equal(SetupEvidenceRequestSchema.parse(validEvidence).schemaVersion, 1);
  assert.throws(() =>
    SetupEvidenceRequestSchema.parse({
      ...validEvidence,
      source: "print('do not send')",
    }),
  );
});

test("setup state contains checked milestones and no callback tokens", () => {
  const state = SetupStateSchema.parse({
    verified: ["clone", "environment"],
    verifiedByBenchmark: { "vision-recognition": ["project", "wiring"] },
  });
  assert.deepEqual(state, {
    verified: ["clone", "environment"],
    verifiedByBenchmark: { "vision-recognition": ["project", "wiring"] },
  });
  assert.throws(() =>
    SetupStateSchema.parse({
      verified: ["clone"],
      verifiedByBenchmark: {},
      tokens: { clone: "legacy-token" },
    }),
  );
});

const TRACK: Benchmark = {
  id: "vision-recognition",
  version: 2,
  contractVersion: "cogworks.submissions.v2",
  entryPointName: "vision-recognition",
  title: "Recognition",
  module: "vision",
  summary: "",
  active: true,
  pluginVersion: "1",
  datasetVersion: "1",
  scorerVersion: "1",
  runtimeVersion: "1",
};

/**
 * `verifiedSteps` is what the portal knows about the machine, and
 * `forBenchmark` what it knows about this track. Splitting them is the point:
 * the install and wiring lines name one benchmark, so evidence from another
 * one must not fill their boxes.
 */
function progress(
  verifiedSteps: SetupStep[],
  cliDeviceCount = 0,
  forBenchmark: SetupStep[] = verifiedSteps,
) {
  return setupCommandProgress(
    setupCommandsForTeam({
      repo: { url: "https://github.com/demo-org/solo", name: "solo" },
      benchmark: TRACK,
      benchmarkId: TRACK.id,
      verifiedSteps,
      verifiedStepsForBenchmark: forBenchmark,
      cliDeviceCount,
      portalOrigin: "https://cogportal.example",
    }),
  );
}

test("setup progress counts only what CogPortal observed", () => {
  // The dashboard nudge and the setup masthead now read this one function, so
  // a count that moved without evidence would move on both at once.
  assert.deepEqual(progress([]), { verified: 0, total: 5 });
  assert.deepEqual(progress(["clone", "environment", "project", "wiring"]), {
    verified: 4,
    total: 5,
  });
});

test("another environment's setup does not tick this track's three lines", () => {
  // The reported defect: set up one track, switch the page to another, and the
  // tool install, the benchmark install and the check all read Verified.
  // Nobody had installed them there, so the page told a student to skip
  // commands whose absence fails at the next one.
  //
  // Three of the four steps describe the active environment, and CogWeb gives
  // each week its own. Only the clone survives a switch, plus the linked
  // device. An older CLI that named no benchmark lands in exactly this state:
  // real evidence about the machine, none about a track.
  assert.deepEqual(progress(["clone", "environment", "project", "wiring"], 1, []), {
    verified: 2,
    total: 5,
  });
  // Checking this track fills them, without a second progress store.
  assert.deepEqual(
    progress(
      ["clone", "environment", "project", "wiring"],
      1,
      ["environment", "project", "wiring"],
    ),
    { verified: 5, total: 5 },
  );
});

test("a student working alone can finish every counted step", () => {
  // The measure this replaced counted a teammates milestone that a solo
  // creator could only clear with a browser checkbox. Nothing counted here
  // depends on a second member, so one person reaches the end on CLI evidence
  // plus one linked device.
  assert.deepEqual(progress(["clone", "environment", "project", "wiring"], 1), {
    verified: 5,
    total: 5,
  });
});
