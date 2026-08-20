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
import type { FailureCategory, Module } from "./schema";

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

/** The parts of a failure that can differ per module. Codes, retryability,
 *  and attempt policy are platform facts and never vary. */
type FailureOverride = Partial<Pick<FailureCopy, "title" | "explanation" | "action">>;

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
      "pip could not resolve or build your declared dependencies inside the benchmark environment, with the course constraints applied.",
    action:
      "Reproduce locally with the command below, then pin versions that install cleanly under the course constraints and push a new commit.",
    reproCommand: "python -m pip install --constraint constraints.txt .",
    retryable: false,
    defaultConsumesAttempt: false,
  },
  data_download: {
    code: "E-DATA",
    title: "Benchmark data is not ready",
    explanation:
      "The fixed benchmark data bundle either could not be downloaded or did not match its reviewed checksum.",
    action:
      "For a local run, reconnect and run the check below so CogBench can rebuild its cache. For an official run, staff repair the private evaluation volume.",
    reproCommand: "cogworks check --benchmark {benchmark}",
    retryable: true,
    defaultConsumesAttempt: false,
  },
  model_cache: {
    code: "E-MODEL",
    title: "Model cache is not ready",
    explanation:
      "A shared model file this benchmark depends on is missing, or it doesn't match the reviewed checksum.",
    action:
      "Run the check below once you're back online so CogBench can refetch it. Official-image failures are repaired by staff.",
    reproCommand: "cogworks check --benchmark {benchmark}",
    retryable: true,
    defaultConsumesAttempt: false,
  },
  adapter_missing: {
    code: "E-ADAPTER",
    title: "Nothing here could be scored",
    // Written before the platform could find a team's code by running it.
    // The old copy said "your package installed, but no entry point was
    // registered" and told them to add one to pyproject.toml, which is
    // packaging metadata that none of the thirteen 2026 capstones has and
    // that the platform no longer needs. Sending a team to write it would
    // cost them an afternoon on the wrong problem.
    explanation:
      "We look for the functions this week asks for by running the code in your repository. Nothing here did the job end to end, and the reason is below.",
    action:
      "Run the check below. It says how far your code was followed and what the next step was given, in your own function names.",
    reproCommand: "cogworks check --benchmark {benchmark}",
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
    reproCommand: "cogworks test --benchmark {benchmark}",
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
    reproCommand: "cogworks run --benchmark {benchmark}",
    retryable: false,
    defaultConsumesAttempt: true,
  },
  timeout: {
    code: "E-TIMEOUT",
    title: "Evaluation exceeded the time limit",
    explanation:
      "Your submission ran past the 15-minute wall-time ceiling and was stopped.",
    action:
      "Profile a single case locally, then batch the work your adapter repeats and stop re-loading model weights on every call.",
    reproCommand: "cogworks run --benchmark {benchmark}",
    retryable: false,
    defaultConsumesAttempt: true,
  },
  memory_limit: {
    code: "E-MEMORY",
    title: "Memory limit exceeded",
    explanation:
      "Your submission exceeded the memory ceiling of the evaluation machine.",
    action:
      "Work through the inputs in batches instead of holding them all at once, and release large intermediate arrays.",
    reproCommand: null,
    retryable: false,
    defaultConsumesAttempt: true,
  },
  output_invalid: {
    code: "E-OUTPUT",
    title: "Predictions did not match the schema",
    explanation:
      "Your adapter returned output that failed schema validation. Extra fields, wrong types, and values outside the allowed range are all rejected.",
    action:
      "Validate your output locally with the schema check, correct the prediction shape, and run practice again before promoting.",
    reproCommand: "cogworks test --benchmark {benchmark}",
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

/**
 * Sharper copy for the failures whose *concept* differs by module, not just
 * their wording: a vision student debugging a slow `recognize()` and a
 * language student debugging a slow `search()` need different next steps.
 *
 * The base entry above must stay true for every module on its own, because a
 * run whose module we haven't resolved yet renders the base. Only override
 * where the module genuinely has better advice; anything omitted falls
 * through.
 *
 * The two hosted interpreters really do differ. Vision evaluates on the 3.11
 * image (Modal's builder dropped 3.8); language evaluates through the pinned
 * CPython 3.8.20 venv baked into `week3_image`. See
 * `apps/runner-modal/src/cogworks_runner/modal_app.py`.
 */
export const MODULE_FAILURE_COPY: Partial<
  Record<Module, Partial<Record<FailureCategory, FailureOverride>>>
> = {
  vision: {
    dependency_install: {
      explanation:
        "pip could not resolve or build your declared dependencies inside the benchmark environment (Python 3.11, course constraints applied).",
    },
    model_cache: {
      title: "FaceNet cache is not ready",
      explanation:
        "The shared FaceNet checkpoint is missing, or it doesn't match the reviewed checksum.",
    },
    timeout: {
      action:
        "Profile recognize() on a single image locally. Batch descriptor computation and avoid re-loading model weights per image.",
    },
    memory_limit: {
      action:
        "Process images one at a time instead of holding the full set in memory, and release large intermediate arrays.",
    },
    output_invalid: {
      explanation:
        "Your adapter returned predictions that failed schema validation. Extra fields, wrong types, and out-of-range boxes are all rejected.",
    },
  },
  language: {
    dependency_install: {
      explanation:
        "pip could not resolve or build your declared dependencies inside the benchmark environment (Python 3.8.20, course constraints applied).",
    },
    model_cache: {
      title: "Course artifact cache is not ready",
      explanation:
        "One of the pinned course artifacts (the GloVe vectors, the COCO captions, or the image descriptors) is missing, or it doesn't match the reviewed checksum.",
    },
    timeout: {
      action:
        "Profile one query locally. Embed the image pool once in prepare_database() rather than per search, and keep GloVe loaded instead of re-reading it on every call.",
    },
    memory_limit: {
      action:
        "Hold one copy of the descriptor and embedding matrices, keep them float32 rather than float64, and release large intermediates.",
    },
    output_invalid: {
      explanation:
        "Your adapter returned rankings that failed schema validation. Wrong types, ids outside the pinned image pool, and more than k results are all rejected.",
    },
  },
};

/**
 * The copy actually rendered for a failure: base entry, then the module
 * override if we know the module, then `{benchmark}` filled in so the
 * reproduce command is the one this student should run.
 */
export function resolveFailureCopy(
  category: FailureCategory,
  context: { benchmarkId: string; module?: Module },
): FailureCopy {
  const base = FAILURE_CATALOG[category];
  const override = context.module
    ? MODULE_FAILURE_COPY[context.module]?.[category]
    : undefined;
  const merged = override ? { ...base, ...override } : base;
  const fill = (text: string) => text.replaceAll("{benchmark}", context.benchmarkId);
  return {
    ...merged,
    explanation: fill(merged.explanation),
    action: fill(merged.action),
    reproCommand: merged.reproCommand === null ? null : fill(merged.reproCommand),
  };
}
