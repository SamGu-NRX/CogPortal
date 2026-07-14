import { FIXTURE_SCENARIOS } from "@shared/fixtures";
import { LOG_CAP_BYTES, type Metric } from "@shared/schema";
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

export function fixtureMetrics(runId: string, branch: string): Metric[] {
  const hash = fnv1a32(runId);
  const improvement = branch === "improved-thresholds" ? 0.004 : 0;
  return [
    {
      key: "recognition_f1",
      label: "Recognition F1",
      value: round4(0.86 + (hash % 800) / 10_000 + improvement),
      unit: null,
      higherIsBetter: true,
      primary: true,
      precision: 3,
    },
    {
      key: "detection_recall",
      label: "Detection recall",
      value: round4(0.9 + ((hash >>> 3) % 700) / 10_000),
      unit: null,
      higherIsBetter: true,
      primary: false,
      precision: 3,
    },
    {
      key: "unknown_rejection",
      label: "Unknown rejection",
      value: round4(0.78 + ((hash >>> 6) % 1500) / 10_000),
      unit: null,
      higherIsBetter: true,
      primary: false,
      precision: 3,
    },
    {
      key: "mean_latency_ms",
      label: "Mean latency",
      value: 240 + ((hash >>> 9) % 160),
      unit: "ms",
      higherIsBetter: false,
      primary: false,
      precision: 0,
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

export function fixtureLog(runId: string, branch: string, sha: string): string {
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
    'entry-point discovery: cogworks.submissions.v1["vision-recognition"]',
    "contract check: 6/6 methods OK",
    "workspace backup complete; restoring into network-disabled evaluation VM",
  ];
  for (let caseNumber = 1; caseNumber <= 32; caseNumber += 1) {
    lines.push(`eval case ${caseNumber.toString().padStart(3, "0")}/032 complete`);
  }

  if (scenario.outcome.kind === "succeeded") {
    const primary = fixtureMetrics(runId, branch)[0]!;
    lines.push("prediction schema: 32/32 cases valid");
    lines.push(`scorer summary: recognition_f1=${primary.value.toFixed(4)}`);
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
      log: fixtureLog(input.runId, input.branch, input.sha),
    };
  }

  async score(_execution: ExecutionResult, input: ResolveAndPrepareInput): Promise<ScoreResult> {
    return { metrics: fixtureMetrics(input.runId, input.branch) };
  }

  async persist(
    _runId: string,
    _execution: ExecutionResult,
    _score: ScoreResult | null,
  ): Promise<void> {
    // Lazy fixture persistence is implemented by syncRun in Milestone 1.
  }
}
