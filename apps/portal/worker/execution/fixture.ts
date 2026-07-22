import { FIXTURE_SCENARIOS } from "@cogworks/contracts/fixtures";
import { LOG_CAP_BYTES, type Metric } from "@cogworks/contracts/schema";
import { fnv1a32 } from "../github/client";
import type {
  ExecutionAdapter,
  ExecutionResult,
  PreparedSubmission,
  ResolveAndPrepareInput,
  ScoreResult,
} from "./adapter";

export function fixtureScenario(branch: string) {
  return (
    FIXTURE_SCENARIOS.find((scenario) => scenario.branch === branch) ??
    FIXTURE_SCENARIOS.find((scenario) => scenario.branch === "main")!
  );
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function fixtureMetrics(
  runId: string,
  branch: string,
  benchmarkId = "vision-recognition",
): Metric[] {
  const hash = fnv1a32(runId);
  const improvement = branch === "improved-thresholds" ? 0.004 : 0;
  if (benchmarkId === "vision-clustering") {
    const pairwise = round4(0.72 + (hash % 1400) / 10_000 + improvement);
    return [
      {
        key: "clustering_pairwise_f1",
        label: "Pairwise F1",
        value: pairwise,
        unit: null,
        higherIsBetter: true,
        primary: true,
        precision: 3,
      },
      {
        key: "adjusted_rand_index",
        label: "Adjusted Rand index",
        value: round4(Math.max(0, pairwise - 0.04)),
        unit: null,
        higherIsBetter: true,
        primary: false,
        precision: 3,
      },
    ];
  }
  const known = round4(0.82 + (hash % 1000) / 10_000 + improvement);
  const lifecycle = round4(0.76 + ((hash >>> 6) % 1200) / 10_000 + improvement);
  return [
    {
      key: "recognition_score",
      label: "Recognition score",
      value: round4((known + lifecycle) / 2),
      unit: null,
      higherIsBetter: true,
      primary: true,
      precision: 3,
    },
    {
      key: "known_identification",
      label: "Known identification",
      value: known,
      unit: null,
      higherIsBetter: true,
      primary: false,
      precision: 3,
    },
    {
      key: "unknown_lifecycle",
      label: "Unknown lifecycle",
      value: lifecycle,
      unit: null,
      higherIsBetter: true,
      primary: false,
      precision: 3,
    },
  ];
}

function failureExcerpt(branch: string): string[] {
  switch (branch) {
    case "loose-pins":
      return [
        "ERROR: Ignored versions that require a different Python version",
        "ERROR: Could not find a matching distribution under the course constraints",
      ];
    case "missing-adapter":
      return ["Traceback (most recent call last):", "  EntryPointNotFound: required adapter is missing"];
    case "heavy-model":
      return ["runner: timeout --kill-after=10s 900s student-eval", "runner: process killed (SIGKILL)"];
    case "raw-tuples":
      return ["Traceback (most recent call last):", "  PredictionSchemaError: invalid prediction 14"];
    case "null-descriptor":
      return ["Traceback (most recent call last):", "  File \"faces.py\", line 87, in recognize"];
    default:
      return ["runner: submission terminated"];
  }
}

export function fixtureLog(
  runId: string,
  branch: string,
  sha: string,
  benchmarkId = "vision-recognition",
): string {
  const scenario = fixtureScenario(branch);
  const lines = [
    `[run ${runId}] preparing isolated Python 3.8.20 workspace`,
    `git clone https://github.com/cogworks-demo/face-finder.git /workspace/repo`,
    `Resolved ref refs/heads/${branch} -> ${sha}`,
    `git checkout --detach ${sha}`,
    "python -m pip 25.0.1 install --constraint /opt/cogportal/constraints.txt .",
    "Requirement already satisfied: numpy==1.24.4",
    "Requirement already satisfied: scipy==1.10.1",
    "Requirement already satisfied: torch==2.2.2",
    "Requirement already satisfied: torchvision==0.17.2",
    "Requirement already satisfied: facenet-pytorch==2.6.0",
    "Requirement already satisfied: Pillow==10.2.0",
    "Requirement already satisfied: opencv-python-headless==4.10.0.84",
    "Requirement already satisfied: scikit-image==0.21.0",
    "Requirement already satisfied: networkx==3.1",
    "Requirement already satisfied: matplotlib==3.7.5",
    "Built wheel for face-finder: face_finder-0.1.0-py3-none-any.whl",
    `entry-point discovery: cogworks.submissions.v2["${benchmarkId}"]`,
    "contract check: adapter factory loaded",
    "workspace backup complete; restoring into network-disabled evaluation VM",
  ];
  for (let caseNumber = 1; caseNumber <= 32; caseNumber += 1) {
    lines.push(`eval case ${caseNumber.toString().padStart(3, "0")}/032 complete`);
  }

  if (scenario.outcome.kind === "succeeded") {
    const primary = fixtureMetrics(runId, branch, benchmarkId)[0]!;
    lines.push("prediction schema: 32/32 cases valid");
    lines.push(`scorer summary: ${primary.key}=${primary.value.toFixed(4)}`);
    lines.push("run completed successfully");
  } else {
    lines.push(...failureExcerpt(branch));
    lines.push(scenario.outcome.detail);
  }

  const encoded = new TextEncoder().encode(lines.join("\n"));
  return new TextDecoder().decode(encoded.slice(0, LOG_CAP_BYTES));
}

export class FixtureExecutionAdapter implements ExecutionAdapter {
  async resolveAndPrepare(input: ResolveAndPrepareInput): Promise<PreparedSubmission> {
    return {
      cacheKey: `${input.repoFullName}:${input.sha}:${input.contractVersion}`,
      sha: input.sha,
      workspaceRef: `fixture-workspace:${input.sha}`,
    };
  }

  async backup(prepared: PreparedSubmission): Promise<string> {
    return `fixture-backup:${prepared.cacheKey}`;
  }

  async execute(_preparedBackup: string, input: ResolveAndPrepareInput): Promise<ExecutionResult> {
    return {
      outcome: fixtureScenario(input.branch).outcome,
      predictionsRef: `fixture-predictions:${input.runId}`,
      log: fixtureLog(input.runId, input.branch, input.sha, input.entryPointName),
    };
  }

  async score(_execution: ExecutionResult, input: ResolveAndPrepareInput): Promise<ScoreResult> {
    return { metrics: fixtureMetrics(input.runId, input.branch, input.entryPointName) };
  }

  async persist(
    _runId: string,
    _execution: ExecutionResult,
    _score: ScoreResult | null,
  ): Promise<void> {
    // Lazy fixture persistence is implemented by syncRun in Milestone 1.
  }
}
