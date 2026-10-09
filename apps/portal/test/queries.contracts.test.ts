import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_RUN_POLL_MS,
  SETUP_STEPS,
  type ConnectionSummary,
  type Dashboard,
  type RunStatus,
  type RunSummary,
} from "@cogworks/contracts/schema";
import {
  connectionsPollInterval,
  dashboardPollInterval,
  requireDiscordLinkToken,
  runPollInterval,
  setupPollInterval,
} from "../src/lib/queries.ts";

/* Fixtures: full contract-valid objects, since the poll functions take
 * whole query results. Only the fields under test vary. */

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0";

const DASHBOARD: Dashboard = {
  benchmark: {
    id: "vision-recognition",
    version: 1,
    contractVersion: "cogworks.submissions.v1",
    entryPointName: "vision-recognition",
    title: "Vision recognition",
    module: "vision",
    summary: "Fixture benchmark",
    active: true,
    pluginVersion: "0.0.1",
    datasetVersion: "0.0.1",
    scorerVersion: "0.0.1",
    runtimeVersion: "0.0.1",
  },
  team: { id: "t1", name: "Fixture team", description: null, repo: null },
  quota: {
    practiceUsed: 0,
    practiceLimit: 10,
    officialUsed: 0,
    officialLimit: 3,
  },
  lastResolvedSha: null,
  activeRun: null,
  latestCandidate: null,
  selection: null,
  runs: [],
};

function dashboardWith(activeRun: RunSummary | null): Dashboard {
  return { ...DASHBOARD, activeRun };
}

function runWith(status: RunStatus): RunSummary {
  return {
    id: "run-1",
    mode: "practice",
    status,
    benchmarkId: "vision-recognition",
    benchmarkVersion: 1,
    branch: "main",
    sha: SHA,
    shortSha: SHA.slice(0, 7),
    createdAt: 0,
    finishedAt: null,
    attemptNumber: null,
    primaryMetric: null,
    failure: null,
  };
}

function connectionsWith(
  cliDevices: ConnectionSummary["cliDevices"],
): ConnectionSummary {
  return { github: null, discord: null, cliDevices };
}

function device(id: string): ConnectionSummary["cliDevices"][number] {
  return { id, name: `cli-${id}`, createdAt: 0, lastUsedAt: null };
}

test("dashboardPollInterval polls at the active rate only while a run is active", () => {
  assert.equal(dashboardPollInterval(undefined), false);
  assert.equal(dashboardPollInterval(dashboardWith(null)), false);
  assert.equal(
    dashboardPollInterval(dashboardWith(runWith("scoring"))),
    ACTIVE_RUN_POLL_MS,
  );
  // Presence-based by contract: the worker clears activeRun once the run
  // reaches a terminal status, so the client polls while the field is set.
  assert.equal(
    dashboardPollInterval(dashboardWith(runWith("queued"))),
    ACTIVE_RUN_POLL_MS,
  );
  // The dashboard rate is the shared active-run constant.
  assert.equal(ACTIVE_RUN_POLL_MS, 2_000);
});

test("runPollInterval polls active statuses and stops at terminal ones", () => {
  assert.equal(runPollInterval(undefined), false);
  for (const status of [
    "queued",
    "preparing",
    "installing",
    "contract_check",
    "evaluating",
    "scoring",
  ] as const) {
    assert.equal(runPollInterval(status), ACTIVE_RUN_POLL_MS, status);
  }
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    assert.equal(runPollInterval(status), false, status);
  }
});

test("connectionsPollInterval polls until a CLI device is linked", () => {
  assert.equal(connectionsPollInterval(undefined), 4_000);
  assert.equal(connectionsPollInterval(connectionsWith([])), 4_000);
  assert.equal(
    connectionsPollInterval(connectionsWith([device("d1")])),
    false,
  );
});

test("setupPollInterval stops only when every setup step is verified", () => {
  assert.equal(setupPollInterval(undefined), 2_500);
  assert.equal(setupPollInterval([]), 2_500);
  assert.equal(setupPollInterval(["clone", "environment"]), 2_500);
  assert.equal(setupPollInterval([...SETUP_STEPS]), false);
});

test("requireDiscordLinkToken returns the token or throws with a specific error", () => {
  assert.equal(requireDiscordLinkToken("tok"), "tok");
  assert.throws(
    () => requireDiscordLinkToken(null),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "useDiscordLinkPreview has no Discord link token to preview. The query must stay disabled until the caller has a token.",
      );
      return true;
    },
  );
  assert.throws(
    () => requireDiscordLinkToken(""),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no Discord link token/);
      return true;
    },
  );
});
