/**
 * Failure catalog (handoff-plan §8, "Run detail behavior").
 *
 * Every known failure renders: the failed phase, a stable code, a
 * plain-language explanation, the exact corrective action, an optional
 * copyable local reproduction command, and whether an official attempt was
 * consumed. Never "Something went wrong".
 *
 * `consumedAttempt` on the run itself is authoritative (set server-side when
 * hidden evaluation has begun); `defaultConsumesAttempt` here only documents
 * the policy for copy.
 */
import type { FailureCategory } from "./schema";

export interface FailureCopy {
  /** Stable, student-visible code (mono chip). */
  code: string;
  title: string;
  explanation: string;
  action: string;
  reproCommand: string | null;
  /** Is re-running the same commit meaningful? (plan: retry only when so) */
  retryable: boolean;
  defaultConsumesAttempt: boolean;
}

export const FAILURE_CATALOG: Record<FailureCategory, FailureCopy> = {
  repository_fetch: {
    code: "E-FETCH",
    title: "Repository could not be fetched",
    explanation:
      "We could not clone your repository at the resolved commit. The repository may have been made private, or the branch may have been deleted.",
    action:
      "Confirm the repository is public and the branch still exists, then start a new run.",
    reproCommand: "git clone <your repository url>",
    retryable: true,
    defaultConsumesAttempt: false,
  },
  dependency_install: {
    code: "E-INSTALL",
    title: "Dependency installation failed",
    explanation:
      "pip could not resolve or build your declared dependencies inside the benchmark environment (Python 3.8.20, course constraints applied).",
    action:
      "Reproduce locally with the command below, then pin versions that support Python 3.8 and push a new commit.",
    reproCommand: "python -m pip install --constraint constraints.txt .",
    retryable: false,
    defaultConsumesAttempt: false,
  },
  data_download: {
    code: "E-DATA",
    title: "Benchmark data is not ready",
    explanation:
      "The fixed benchmark image bundle could not be downloaded or failed integrity validation.",
    action:
      "For a local run, reconnect and retry so CogBench can rebuild the selected-image cache. For an official run, staff must repair the private evaluation volume.",
    reproCommand: "cogworks check --benchmark vision-recognition",
    retryable: true,
    defaultConsumesAttempt: false,
  },
  model_cache: {
    code: "E-MODEL",
    title: "FaceNet cache is not ready",
    explanation:
      "The shared FaceNet checkpoint is missing or does not match the reviewed checksum.",
    action:
      "Run the local doctor and retry once online. Official-image failures are repaired by staff and do not consume an attempt.",
    reproCommand: "cogworks check --benchmark vision-recognition",
    retryable: true,
    defaultConsumesAttempt: false,
  },
  adapter_missing: {
    code: "E-ADAPTER",
    title: "Benchmark adapter not found",
    explanation:
      "Your package installed, but no entry point for this track was registered under the active submission contract group.",
    action:
      'Add the v2 entry point to pyproject.toml and push:\n[project.entry-points."cogworks.submissions.v2"]\nvision-recognition = "benchmark_adapter:create_recognition_adapter"',
    reproCommand: "cogworks check --benchmark vision-recognition",
    retryable: false,
    defaultConsumesAttempt: false,
  },
  contract_invalid: {
    code: "E-CONTRACT",
    title: "Adapter does not satisfy the contract",
    explanation:
      "Your adapter imported, but it is missing behavior required by the active track contract.",
    action:
      "Run the local contract check to see exactly which method failed, fix it, and push a new commit.",
    reproCommand: "cogworks test --benchmark vision-recognition",
    retryable: false,
    defaultConsumesAttempt: false,
  },
  student_runtime: {
    code: "E-RUNTIME",
    title: "Your code raised an exception",
    explanation:
      "Evaluation started, but your submission raised an unhandled exception while processing benchmark inputs.",
    action:
      "Reproduce with the local practice runner; the traceback excerpt is in the log below. Fix, verify locally, then run practice again before promoting.",
    reproCommand: "python -m cogworks_benchmark run vision-recognition",
    retryable: false,
    defaultConsumesAttempt: true,
  },
  timeout: {
    code: "E-TIMEOUT",
    title: "Evaluation exceeded the time limit",
    explanation:
      "Your submission ran past the 15-minute wall-time ceiling and was stopped.",
    action:
      "Profile recognize() on a single image locally. Batch descriptor computation and avoid re-loading model weights per image.",
    reproCommand: "python -m cogworks_benchmark run vision-recognition --timing",
    retryable: false,
    defaultConsumesAttempt: true,
  },
  memory_limit: {
    code: "E-MEMORY",
    title: "Memory limit exceeded",
    explanation:
      "Your submission exceeded the 8 GiB memory ceiling of the evaluation machine.",
    action:
      "Process images one at a time instead of holding the full set in memory, and release large intermediate arrays.",
    reproCommand: null,
    retryable: false,
    defaultConsumesAttempt: true,
  },
  output_invalid: {
    code: "E-OUTPUT",
    title: "Predictions did not match the schema",
    explanation:
      "Your adapter returned predictions that failed schema validation (extra fields, wrong types, or out-of-range boxes are rejected).",
    action:
      "Validate your output locally with the schema check, correct the prediction shape, and run practice again before promoting.",
    reproCommand: "python -m cogworks_benchmark check vision-recognition --output",
    retryable: false,
    defaultConsumesAttempt: true,
  },
  scorer: {
    code: "E-SCORER",
    title: "Scoring failed on our side",
    explanation:
      "Your predictions were produced and retrieved, but the trusted scorer failed. This is a platform problem, not a problem with your code.",
    action:
      "Staff have been notified with this run's ID. Your attempt was not consumed; you may retry once the issue is resolved.",
    reproCommand: null,
    retryable: true,
    defaultConsumesAttempt: false,
  },
  provider: {
    code: "E-PROVIDER",
    title: "Execution provider failed",
    explanation:
      "The isolated execution environment failed before your code ran. This is a platform problem, not a problem with your code.",
    action:
      "Retry the run. If this recurs, report the run ID to course staff.",
    reproCommand: null,
    retryable: true,
    defaultConsumesAttempt: false,
  },
};
