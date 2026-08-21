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

/** The scripted outcome with its detail told in the requested track's terms.
 *  Tracks without their own wording keep the default. */
export function fixtureOutcome(branch: string, benchmarkId: string) {
  const { outcome } = fixtureScenario(branch);
  if (outcome.kind === "succeeded") return outcome;
  return {
    ...outcome,
    detail: outcome.detailByBenchmark?.[benchmarkId] ?? outcome.detail,
  };
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
  if (benchmarkId === "language-search") {
    // Shapes match the real scorer under retrieval-v3, measured on the
    // reference submission on the evaluation tier (2026-08-20): text 0.7829,
    // retrieval 0.2586, search 0.2309, with the four rungs at 0.2572
    // (verbatim), 0.2735 (keywords), 0.1671 (truncated), 0.2256 (typo).
    //
    // Search used to be modelled as retrieval minus 0.006, which matched the
    // old scorer because `search_mrr` was then the verbatim rung over the
    // same pool retrieval already ranked. It now averages the four query
    // rewrites, so it sits meaningfully below retrieval and the preview has
    // to as well: a fixture that still showed the two nearly equal would
    // teach whoever reads it the wrong shape.
    const text = round4(0.74 + (hash % 900) / 10_000 + improvement);
    const retrieval = round4(0.23 + ((hash >>> 4) % 1100) / 10_000 + improvement);
    // Reference ratios against the verbatim rung: keywords 1.063, truncated
    // 0.649, typo 0.877, and verbatim itself 0.9947 of retrieval.
    const verbatim = round4(Math.max(0, retrieval * 0.9947));
    const keywords = round4(Math.max(0, verbatim * 1.063));
    const truncated = round4(Math.max(0, verbatim * 0.649));
    const typo = round4(Math.max(0, verbatim * 0.877));
    const search = round4((verbatim + keywords + truncated + typo) / 4);
    const metric = (key: string, label: string, value: number, primary = false): Metric => ({
      key,
      label,
      value,
      unit: null,
      higherIsBetter: key !== "retrieval_median_rank",
      primary,
      precision: 3,
    });
    return [
      metric("overall", "Overall", round4((text + retrieval + search) / 3), true),
      metric("text_mrr", "Text MRR", text),
      metric("retrieval_mrr", "Retrieval MRR", retrieval),
      metric("search_mrr", "Search MRR", search),
      metric("retrieval_recall_at_1", "Recall@1", round4(retrieval * 0.52)),
      metric("retrieval_recall_at_5", "Recall@5", round4(Math.min(1, retrieval * 1.44))),
      metric("retrieval_recall_at_10", "Recall@10", round4(Math.min(1, retrieval * 2.2))),
      metric("retrieval_median_rank", "Median rank", round4(8 + ((hash >>> 9) % 40) / 10)),
      // Three floors, not one. Retrieval ranks the whole 700-image pool;
      // search returns 50 ids and scores anything past them as a miss, so its
      // floor is lower; text ranks captions among captions, so its floor is
      // higher. Exact values from the evaluation tier.
      metric("chance_mrr", "Chance MRR", 0.0102),
      metric("text_chance", "Text chance MRR", 0.04),
      metric("search_chance", "Search chance MRR", 0.0064),
      metric("search_mrr_verbatim", "Search MRR, caption unchanged", verbatim),
      metric("search_mrr_keywords", "Search MRR, keywords only", keywords),
      metric("search_mrr_truncated", "Search MRR, first three words", truncated),
      metric("search_mrr_typo", "Search MRR, one typo", typo),
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
  const language = benchmarkId === "language-search";
  const installLines = language
    ? [
        "Requirement already satisfied: numpy==1.24.4",
        "Requirement already satisfied: gensim==4.3.3",
        "Requirement already satisfied: platformdirs==4.3.6",
        "Requirement already satisfied: mygrad==2.2.0",
        "Built wheel for face-finder: face_finder-0.1.0-py3-none-any.whl",
      ]
    : [
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
      ];
  const lines = [
    // Hosted control runtime is 3.11; week3 evaluates student code through
    // the image's pinned CPython 3.8.20 venv (see modal_app.week3_image).
    `[run ${runId}] preparing isolated Python ${language ? "3.8.20" : "3.11"} workspace`,
    `git clone https://github.com/cogworks-demo/face-finder.git /workspace/repo`,
    `Resolved ref refs/heads/${branch} -> ${sha}`,
    `git checkout --detach ${sha}`,
    "python -m pip 25.0.1 install --constraint /opt/cogportal/constraints.txt .",
    ...installLines,
    `entry-point discovery: cogworks.submissions.v2["${benchmarkId}"]`,
    "contract check: adapter factory loaded",
    "workspace backup complete; restoring into network-disabled evaluation VM",
  ];
  if (language) {
    lines.push("loading GloVe KeyedVectors (glove.6B.200d.kv, memory-mapped)");
    for (const component of ["text", "retrieval", "search"]) {
      lines.push(`eval component ${component} complete`);
    }
    lines.push(
      'showcase 01/10 "two dogs running on a sandy beach" -> http://images.cocodataset.org/train2014/COCO_train2014_000000084887.jpg',
    );
  } else {
    for (let caseNumber = 1; caseNumber <= 32; caseNumber += 1) {
      lines.push(`eval case ${caseNumber.toString().padStart(3, "0")}/032 complete`);
    }
  }

  if (scenario.outcome.kind === "succeeded") {
    const primary = fixtureMetrics(runId, branch, benchmarkId)[0]!;
    lines.push(language ? "prediction schema: 3/3 components valid" : "prediction schema: 32/32 cases valid");
    lines.push(`scorer summary: ${primary.key}=${primary.value.toFixed(4)}`);
    lines.push("run completed successfully");
  } else {
    lines.push(...failureExcerpt(branch));
    const outcome = fixtureOutcome(branch, benchmarkId);
    if (outcome.kind === "failed") lines.push(outcome.detail);
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
      outcome: fixtureOutcome(input.branch, input.entryPointName),
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
