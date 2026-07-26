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
});

export const BenchmarkResultV1Schema = z.object({
  protocolVersion: RunnerProtocolVersionSchema,
  benchmarkId: z.string().min(1).max(120),
  benchmarkVersion: z.number().int().positive(),
  metrics: z.array(ProtocolMetricSchema).min(1).max(32),
  diagnostics: z.array(z.string().max(240)).max(32),
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
    }),
  }),
]);
export type RunEventV1 = z.infer<typeof RunEventV1Schema>;
