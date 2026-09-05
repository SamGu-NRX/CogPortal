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
  const state = SetupStateSchema.parse({ verified: ["clone", "wiring"] });
  assert.deepEqual(state, { verified: ["clone", "wiring"] });
  assert.throws(() =>
    SetupStateSchema.parse({
      verified: ["clone"],
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

function progress(verifiedSteps: SetupStep[], cliDeviceCount = 0) {
  return setupCommandProgress(
    setupCommandsForTeam({
      repo: { url: "https://github.com/demo-org/solo", name: "solo" },
      benchmark: TRACK,
      benchmarkId: TRACK.id,
      verifiedSteps,
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
