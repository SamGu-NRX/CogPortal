/** Diagnostic copy and corrective actions for each failure category.
 * Failed executions do not consume practice or official quota.
 */
import { EVALUATION_TIME_LIMIT_SECONDS, type FailureCategory, type Module } from "./schema";

export interface FailureCopy {
  /** Stable, student-visible code (mono chip). */
  code: string;
  title: string;
  explanation: string;
  action: string;
  reproCommand: string | null;
  /**
   * What can change the outcome, which decides the run page's next step.
   *
   * - "fix": only a new commit can. The runner observed the cause in what the
   *   submission did (its install, contract, output, time or memory), so the
   *   card leads with the local reproduction and offers no Retry.
   * - "retry": the cause was on our side, so the same commit can pass.
   * - "either": the evaluation raised, and the runner cannot say whose line
   *   raised it, because team code and benchmark code share one process and
   *   team code can forge anything that process reports. The card shows where
   *   it was raised and offers both.
   */
  remedy: "fix" | "retry" | "either";
}

/** Copy can differ per module; codes and remedies are platform facts. */
type FailureOverride = Partial<Pick<FailureCopy, "title" | "explanation" | "action">>;

export const FAILURE_CATALOG: Record<FailureCategory, FailureCopy> = {
  repository_fetch: {
    code: "E-FETCH",
    title: "Repository could not be fetched",
    explanation:
      "We could not clone your repository at the resolved commit. The repository may have been made private, or the branch may have been deleted.",
    action:
      "Confirm the repository is public and the recorded commit is still available.",
    reproCommand: "git clone <your repository url>",
    remedy: "retry",
  },
  dependency_install: {
    code: "E-INSTALL",
    title: "Dependency installation failed",
    explanation:
      "pip could not resolve or build your declared dependencies inside the benchmark environment, with the course constraints applied.",
    action:
      "Reproduce locally with the command below, then pin versions that install cleanly under the course constraints and push a new commit.",
    reproCommand: "python -m pip install --constraint constraints.txt .",
    remedy: "fix",
  },
  data_download: {
    code: "E-DATA",
    title: "Benchmark data is not ready",
    explanation:
      "The fixed benchmark data bundle either could not be downloaded or did not match its reviewed checksum.",
    action:
      "For a local run, reconnect and run the check below so CogBench can rebuild its cache. For an official run, staff repair the private evaluation volume.",
    reproCommand: "cogworks check --benchmark {benchmark}",
    remedy: "retry",
  },
  model_cache: {
    code: "E-MODEL",
    title: "Model cache is not ready",
    explanation:
      "A shared model file this benchmark depends on is missing, or it doesn't match the reviewed checksum.",
    action:
      "Run the check below once you're back online so CogBench can refetch it. Official-image failures are repaired by staff.",
    reproCommand: "cogworks check --benchmark {benchmark}",
    remedy: "retry",
  },
  adapter_missing: {
    code: "E-ADAPTER",
    title: "Nothing here could be scored",
    // Says nothing about pyproject.toml entry points: that is packaging
    // metadata none of the thirteen 2026 capstones has, and the platform no
    // longer needs it now that it finds a team's code by running it.
    // This code also covers a search that stopped partway, after the team's
    // own installation ran, when nobody can say whose code stopped it. The
    // explanation therefore claims only that scoring was not reached.
    explanation:
      "This run did not reach scoring. The available details are below.",
    action:
      "Run the check below. It says how far your code was followed and what the next step was given, in your own function names.",
    reproCommand: "cogworks check --benchmark {benchmark}",
    remedy: "fix",
  },
  contract_invalid: {
    code: "E-CONTRACT",
    title: "Adapter does not satisfy the contract",
    explanation:
      "Your adapter imported, but it is missing behavior required by the active track contract.",
    action:
      "Run the local contract check to see exactly which method failed, fix it, and push a new commit.",
    reproCommand: "cogworks test --benchmark {benchmark}",
    remedy: "fix",
  },
  // The category is named for the old claim. It now means only that the
  // evaluation raised. Team and benchmark code share the sandbox process, and
  // team code can forge any frame, so the runner can't say whose line it was:
  // the platform's own replay raised in B-44, and this title once told that
  // team the crash was theirs. The copy stays neutral and lets the detail's
  // file and line speak; it never promises a repeat fixes a benchmark bug.
  // Staff cannot open a team's run (GET /api/runs/:id answers only that
  // team), so the escalations here and below ask for what a student can
  // hand over: the error and the run number the run page shows at its top.
  // FailureCard on the run page is the only place these actions render.
  student_runtime: {
    code: "E-RUNTIME",
    title: "The evaluation stopped on an exception",
    explanation:
      "The error below shows what was raised and where.",
    action:
      "If it points to a file in your repository, reproduce it with the command below. If it points elsewhere, send course staff the error above and the run number at the top of this page, then retry once they've fixed it.",
    reproCommand: "cogworks run --benchmark {benchmark}",
    remedy: "either",
  },
  timeout: {
    code: "E-TIMEOUT",
    title: "Evaluation exceeded the time limit",
    explanation: `Your submission ran past the ${EVALUATION_TIME_LIMIT_SECONDS / 60}-minute wall-time ceiling and was stopped.`,
    action:
      "Profile a single case locally, then batch the work your adapter repeats and stop re-loading model weights on every call.",
    reproCommand: "cogworks run --benchmark {benchmark}",
    remedy: "fix",
  },
  memory_limit: {
    code: "E-MEMORY",
    title: "Memory limit exceeded",
    explanation:
      "Your submission exceeded the memory ceiling of the evaluation machine.",
    action:
      "Work through the inputs in batches instead of holding them all at once, and release large intermediate arrays.",
    reproCommand: null,
    remedy: "fix",
  },
  // Written against the one place that raises it,
  // apps/runner-modal/src/cogworks_runner/prediction_validation.py. That
  // check runs only on the hosted side, so the action names what a student
  // can run and says plainly that the local run is not the same check.
  output_invalid: {
    code: "E-OUTPUT",
    title: "Results came back in a shape scoring can't read",
    explanation:
      "Before scoring, the runner checks every result your adapter returned: one per case, each of the type this benchmark scores, with finite numbers where scoring does arithmetic. The line above is the first problem it found.",
    // The runner's line is the instruction (which result, which field, or
    // that the count is off and whose list that is), so this defers to it.
    action:
      "The line above says what the runner refused and where to look. This runs your adapter on the small cases locally, but it doesn't repeat the runner's check:",
    reproCommand: "cogworks test --benchmark {benchmark}",
    remedy: "fix",
  },
  scorer: {
    code: "E-SCORER",
    title: "Scoring failed on our side",
    explanation:
      "Your predictions were produced and retrieved, but the trusted scorer failed. This is a platform problem, not a problem with your code.",
    action:
      "If scoring keeps failing, send course staff the run number at the top of this page.",
    reproCommand: null,
    remedy: "retry",
  },
  provider: {
    code: "E-PROVIDER",
    title: "The run couldn't finish",
    explanation:
      "The hosted execution could not finish. The recorded details may identify where it stopped.",
    action:
      "If the run keeps failing, send course staff the run number at the top of this page.",
    reproCommand: null,
    remedy: "retry",
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
