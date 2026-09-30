import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SetupEvidenceRequestSchema,
  SetupStateSchema,
} from "@cogworks/contracts/schema";
import { setupSteps, verifiedSteps } from "../src/lib/setup-progress.ts";

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

test("setup evidence accepts the CLI's checked benchmark without relaxing other fields", () => {
  const payload = { ...validEvidence, checkedBenchmarkId: "vision-recognition" };
  assert.equal(SetupEvidenceRequestSchema.parse(payload).checkedBenchmarkId, "vision-recognition");
  assert.throws(() => SetupEvidenceRequestSchema.parse({ ...payload, checkedBenchmarkId: "" }));
  assert.throws(() => SetupEvidenceRequestSchema.parse({ ...payload, source: "private" }));
});

test("setup state contains checked milestones and no callback tokens", () => {
  const state = SetupStateSchema.parse({
    verified: ["clone"],
    verifiedByBenchmark: { "vision-recognition": ["environment", "project", "wiring"] },
  });
  assert.deepEqual(state, {
    verified: ["clone"],
    verifiedByBenchmark: { "vision-recognition": ["environment", "project", "wiring"] },
  });
  assert.throws(() =>
    SetupStateSchema.parse({
      verified: ["clone"],
      tokens: { clone: "legacy-token" },
    }),
  );
});

test("legacy browser checks cannot impersonate CLI-verified machine facts", () => {
  const progress = setupSteps(
    "created",
    new Set(["teammates", "clone", "environment", "project", "wiring"]),
    { teammates: false, terminal: [] },
  );
  assert.deepEqual(progress, { done: 2, total: 6 });
});

test("a check scoped to the shown benchmark counts, and the nudge counts any benchmark's", () => {
  const state = SetupStateSchema.parse({
    verified: ["clone"],
    verifiedByBenchmark: { "vision-recognition": ["environment", "project", "wiring"] },
  });
  assert.deepEqual(verifiedSteps(state, "vision-recognition"), ["clone", "environment", "project", "wiring"]);
  assert.deepEqual(verifiedSteps(state, "audio-identification"), ["clone"]);
  assert.deepEqual(verifiedSteps(state), ["clone", "environment", "project", "wiring"]);
  assert.deepEqual(verifiedSteps(undefined), []);
});
