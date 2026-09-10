import { z } from "zod";

export const RUNNER_PROTOCOL_VERSION = "1" as const;
export const RunnerProtocolVersionSchema = z.literal(RUNNER_PROTOCOL_VERSION);

export const ProtocolMetricSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().max(32).nullable(),
  higherIsBetter: z.boolean(),
  primary: z.boolean(),
  precision: z.number().int().min(0).max(6),
  /**
   * What this measures, in the course's own vocabulary, and which part of the
   * capstone it corresponds to. Optional because plugins written before it
   * exists do not send one; a metric with no explanation renders without the
   * help affordance rather than with an empty one.
   */
  help: z.string().max(600).optional(),
  /**
   * What kind of number this is, which decides how the run page draws it.
   *
   * Every metric used to render as one row with an up or down arrow, and the
   * arrow is an assertion: this measures your submission and here is the
   * direction of better. That is false for a floor, which is a property of
   * the dataset. Week 3 published three of them and drew "higher is better"
   * on all three, which reads as advice to raise a number the submission
   * does not control.
   *
   * `floorOf` and `reportedFor` name the metric this one belongs beside. A
   * floor is the scale its metric sits on, so it renders inline rather than
   * as its own row. A reported metric is run and deliberately not scored,
   * and it only means anything next to its scored counterpart: Week 3's
   * verbatim probes are answerable from the file the submission is handed,
   * so the gap between them and the scored number is the reading.
   *
   * Absent means "scored", which is what every metric was before this
   * existed, so a benchmark that declares nothing renders exactly as it did.
   */
  // Restated rather than imported from schema.ts: this package's own tests run
  // under Node's type stripping, which needs a ".ts" extension the portal's
  // tsconfig rejects. "the two role lists stay in step" in test/protocol.test.ts
  // is what keeps this honest. This is the copy the runner callback validates
  // against, so a role here that schema.ts lacks would be stored and then
  // rejected by the browser, failing the whole run-detail request.
  role: z.enum(["scored", "floor", "reported", "diagnostic", "plotted"]).optional(),
  /** The metric this one is the floor of, or is reported alongside. */
  relatesTo: z.string().max(80).optional(),
});

/**
 * One point on a benchmark's difficulty sweep.
 *
 * The course teaches a sweep rather than a single measurement: grow the
 * library, watch where performance degrades. `axis` names what was varied in
 * the course's own words ("songs in the library"), because the knob differs
 * per benchmark and the run page should not have to know which is which.
 */
export const SweepPointSchema = z.object({
  x: z.number(),
  y: z.number().min(0).max(1),
  label: z.string().max(40).optional(),
});

export const SweepSchema = z.object({
  axis: z.string().min(1).max(60),
  metric: z.string().min(1).max(60),
  points: z.array(SweepPointSchema).min(2).max(24),
});

/**
 * Which of the team's own functions ran, in the order they ran.
 *
 * Present when the platform found their code itself rather than being told
 * where it was, which for every 2026 repository is always. A score that rests
 * on an inference should show the inference: a team can read this and see
 * whether the code we ran is the code they think we ran.
 */
export const WiredStepSchema = z.object({
  stage: z.string().min(1).max(60),
  function: z.string().min(1).max(200),
  received: z.string().max(200).optional(),
  returned: z.string().max(200).optional(),
});
export type WiredStep = z.infer<typeof WiredStepSchema>;

/** One file the run could not read, and whose problem that is. */
export const SkippedModuleSchema = z.object({
  module: z.string().min(1).max(200),
  reason: z.string().max(300),
  owner: z.string().max(20).default("theirs"),
});
export type SkippedModule = z.infer<typeof SkippedModuleSchema>;

/**
 * One exception out of their own code, where a compiler would print it.
 *
 * `file` is relative to their repository and `line` is a line in it, so a
 * team can open the file and look. The message is the exception type and its
 * first line, which is all the platform is willing to say: it reports what it
 * saw and never guesses at a cause.
 */
export const RaisedSchema = z.object({
  file: z.string().min(1).max(200),
  line: z.number().int().min(0),
  function: z.string().max(200),
  message: z.string().max(200),
});
export type Raised = z.infer<typeof RaisedSchema>;

/**
 * A refusal a student can act on.
 *
 * Written by `cogbench.verdict`, which has one rule: it says what it saw and
 * never guesses at a cause. It cannot know which of their lines is wrong, and
 * a confident wrong guess costs more than saying nothing.
 */
export const RefusalSchema = z.object({
  /** Which outcome this is: scored, wired_but_wrong, not_wired, not_read,
   *  nothing_here, or could_not_look. The last one means the check could not
   *  read part of the repository for a reason of ours, so it declined to say
   *  anything about the code. Kept as a string rather than an enum so a new
   *  outcome reaches the page as itself instead of failing the parse. */
  status: z.string().min(1).max(40),
  /** One sentence naming what stopped, in the student's own function names. */
  headline: z.string().max(600),
  /** The one thing worth doing about it, when the platform honestly knows.
   *  Empty when it does not, which is most of the time. */
  nextStep: z.string().max(600).default(""),
  /** How far the search got: each step it bound, and the shapes it saw. */
  trace: z.array(WiredStepSchema).max(16).default([]),
  /** What the search learned that the headline does not say. Prose, and the
   *  only part of a refusal that is written as sentences. */
  notes: z.array(z.string().max(600)).max(8).default([]),
  /** Files the run could not read, and why. `owner` is "theirs", "ours", or
   *  "environment": a module we skipped for a reason of ours is our fault
   *  and the page has to say so rather than let it read as their bug. */
  skipped: z.array(SkippedModuleSchema).max(32).default([]),
  /** What their code raised while the search called it, with the file and
   *  line inside their repository. */
  errors: z.array(RaisedSchema).max(16).default([]),
});
export type Refusal = z.infer<typeof RefusalSchema>;

// Workers caps request bodies at 100 MB on Free and Pro plans, and this
// account's plan is not established. The largest trained weight in the 2026
// corpus is 411 KB. Week 3's separate 200 MiB discovery probe is unchanged.
export const MAX_WEIGHT_BYTES = 100 * 1024 * 1024;

export const WeightFileSchema = z.object({
  path: z.string().min(1).max(500),
  size: z.number().int().nonnegative().max(MAX_WEIGHT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WeightFile = z.infer<typeof WeightFileSchema>;

export const BenchmarkResultV1Schema = z.object({
  protocolVersion: RunnerProtocolVersionSchema,
  benchmarkId: z.string().min(1).max(120),
  benchmarkVersion: z.number().int().positive(),
  metrics: z.array(ProtocolMetricSchema).min(1).max(32),
  /**
   * One note is one instruction about what to change next, so it has to arrive
   * whole. At 240 the scorers were cut mid-word: week 1's notes run to 315
   * characters and week 2's abstention note to 392, and what the cut removed
   * was the advice at the end rather than the description at the start.
   *
   * 600 matches what a refusal's prose fields already allow in this file. Both
   * ends of the wire have to agree, so the portal is deployed before the
   * runner: the worker answers 400 for a longer string and the runner does not
   * retry a 400, which would lose the whole completed event.
   */
  diagnostics: z.array(z.string().max(600)).max(32),
  weightsSupplied: z.array(z.string().min(1).max(500)).max(32).optional(),
  /**
   * Optional: a benchmark whose difficulty has no natural knob omits it, and
   * the run page shows the metric grid alone rather than an empty axis.
   */
  sweep: SweepSchema.optional(),
  /**
   * Optional, and absent for a repository that declared its own submission:
   * there is no inference to show when a team told us where their code is.
   */
  wiring: z.array(WiredStepSchema).max(16).optional(),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BenchmarkResultV1 = z.infer<typeof BenchmarkResultV1Schema>;

export const RunJobV1Schema = z.object({
  protocolVersion: RunnerProtocolVersionSchema,
  jobId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  mode: z.enum(["practice", "official"]),
  preparedArtifactId: z.string().min(1).max(200).nullable(),
  source: z.object({
    repositoryId: z.number().int().positive().nullable(),
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    archiveUrl: z.string().url().startsWith("https://"),
  }),
  benchmark: z.object({
    id: z.string().min(1).max(120),
    version: z.number().int().positive(),
    contractVersion: z.string().min(1).max(120),
    pluginVersion: z.string().min(1).max(80),
    datasetVersion: z.string().min(1).max(80),
    scorerVersion: z.string().min(1).max(80),
  }),
  runtime: z.object({
    pythonVersion: z.string().regex(/^3\.\d{1,2}$/),
    imageDigest: z.string().min(1).max(200),
    cpu: z.number().positive().max(16),
    memoryMb: z.number().int().min(128).max(65_536),
    timeoutSeconds: z.number().int().min(5).max(3_600),
    maxOutputBytes: z.number().int().min(1_024).max(10 * 1024 * 1024),
  }),
  callback: z.object({
    url: z.string().url().startsWith("https://"),
    keyId: z.string().min(1).max(80),
  }),
  // The 2026 corpus has at most three candidates in one repository, and
  // discovery loads one. Eight rejects a broken report before preparation.
  weights: z.array(WeightFileSchema).max(8).optional(),
});
export type RunJobV1 = z.infer<typeof RunJobV1Schema>;

const RunEventBaseSchema = z.object({
  protocolVersion: RunnerProtocolVersionSchema,
  eventId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.number().int().positive(),
});

export const RunEventV1Schema = z.discriminatedUnion("type", [
  RunEventBaseSchema.extend({
    type: z.literal("status"),
    status: z.enum([
      "preparing",
      "installing",
      "contract_check",
      "evaluating",
      "scoring",
    ]),
    elapsedMs: z.number().int().nonnegative().optional(),
    progress: z
      .object({
        current: z.number().int().nonnegative(),
        total: z.number().int().positive(),
        unit: z.enum(["cases", "items"]),
      })
      .refine((value) => value.current <= value.total)
      .optional(),
  }),
  RunEventBaseSchema.extend({
    type: z.literal("completed"),
    result: BenchmarkResultV1Schema,
    preparedArtifactId: z.string().min(1).max(200),
    environmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sanitizedLog: z.string().max(8 * 1024).nullable(),
  }),
  RunEventBaseSchema.extend({
    type: z.literal("failed"),
    failure: z.object({
      category: z.enum([
        "repository_fetch",
        "dependency_install",
        // The Modal runner emits these two (data volume and model cache
        // failures); the enum previously omitted them, so those callbacks
        // were rejected with a 400 before reaching the run.
        "data_download",
        "model_cache",
        "adapter_missing",
        "contract_invalid",
        "student_runtime",
        "timeout",
        "memory_limit",
        "output_invalid",
        "scorer",
        "provider",
      ]),
      phase: z.enum([
        "queued",
        "preparing",
        "installing",
        "contract_check",
        "evaluating",
        "scoring",
      ]),
      detail: z.string().max(240).nullable(),
      infrastructure: z.boolean(),
      /**
       * Why the platform could not find code to score, when that is what
       * failed. `detail` is one capped line, which is right for a log and
       * wrong for the thing a student acts on: a refusal names the step that
       * stalled, the shape the last of their functions returned, the modules
       * that could not be read, and the one next thing to do. Truncating that
       * to 240 characters loses the part that helps.
       *
       * Absent for every other kind of failure. Their code raising is theirs
       * to read, and the log is where it belongs.
       */
      refusal: RefusalSchema.optional(),
    }),
  }),
]);
export type RunEventV1 = z.infer<typeof RunEventV1Schema>;
