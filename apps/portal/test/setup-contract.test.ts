import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SetupEvidenceRequestSchema,
  SetupStateSchema,
} from "@cogworks/contracts/schema";
import { setupSteps } from "../src/lib/setup-progress.ts";

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

test("legacy browser checks cannot impersonate CLI-verified machine facts", () => {
  const progress = setupSteps(
    "created",
    new Set(["teammates", "clone", "environment", "project", "wiring"]),
    { teammates: false, terminal: [] },
  );
  assert.deepEqual(progress, { done: 2, total: 6 });
});
