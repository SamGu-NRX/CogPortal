/**
 * Deterministic fixture benchmark (handoff-plan §1 "initial vertical slice
 * uses a deterministic fixture benchmark", Milestone 1).
 *
 * The fixture GitHub client exposes one repository with these branches; the
 * branch chosen for a run selects a scripted outcome so every UX state —
 * success, each failure category, quota exhaustion — is demonstrable without
 * a live sandbox provider.
 */
import type { FailureCategory, RunPhase } from "./schema";

export interface FixtureScenario {
  branch: string;
  /** What the student sees in the branch picker. */
  hint: string;
  outcome:
    | { kind: "succeeded" }
    | { kind: "failed"; category: FailureCategory; phase: RunPhase; detail: string };
}

export const FIXTURE_SCENARIOS: FixtureScenario[] = [
  {
    branch: "main",
    hint: "healthy submission — completes and scores",
    outcome: { kind: "succeeded" },
  },
  {
    branch: "improved-thresholds",
    hint: "healthy submission — slightly different metrics",
    outcome: { kind: "succeeded" },
  },
  {
    branch: "missing-adapter",
    hint: "no cogworks.submissions.v2 entry point",
    outcome: {
      kind: "failed",
      category: "adapter_missing",
      phase: "contract_check",
      detail:
        'Entry-point group "cogworks.submissions.v2" has no "vision-recognition" registration.',
    },
  },
  {
    branch: "loose-pins",
    hint: "dependency resolution fails on Python 3.8",
    outcome: {
      kind: "failed",
      category: "dependency_install",
      phase: "installing",
      detail:
        "ERROR: Could not find a version that satisfies the requirement numpy>=2.0 (Python 3.8).",
    },
  },
  {
    branch: "heavy-model",
    hint: "exceeds the wall-time ceiling during evaluation",
    outcome: {
      kind: "failed",
      category: "timeout",
      phase: "evaluating",
      detail: "Process exceeded 900 s wall time and was terminated (SIGKILL after grace).",
    },
  },
  {
    branch: "raw-tuples",
    hint: "returns predictions that fail schema validation",
    outcome: {
      kind: "failed",
      category: "output_invalid",
      phase: "scoring",
      detail:
        'Prediction 14: expected object with keys ["box","identity"], got 4-tuple.',
    },
  },
  {
    branch: "null-descriptor",
    hint: "raises during evaluation on a no-face image",
    outcome: {
      kind: "failed",
      category: "student_runtime",
      phase: "evaluating",
      detail:
        "TypeError: 'NoneType' object is not subscriptable — recognize() at faces.py:87 on case 041.",
    },
  },
];

/** Per-phase durations (ms) for the scripted lifecycle — ~21 s end to end,
 *  long enough that the 2 s poll renders every stage distinctly. */
export const FIXTURE_PHASE_DURATIONS_MS: Record<RunPhase, number> = {
  queued: 1200,
  preparing: 3500,
  installing: 5200,
  contract_check: 1800,
  evaluating: 7600,
  scoring: 1900,
};

export const FIXTURE_REPO = {
  repositoryId: 1,
  owner: "cogworks-demo",
  name: "face-finder",
  fullName: "cogworks-demo/face-finder",
  url: "https://github.com/cogworks-demo/face-finder",
  defaultBranch: "main",
  description:
    "Deterministic demo repository; each branch scripts a different run outcome.",
} as const;
