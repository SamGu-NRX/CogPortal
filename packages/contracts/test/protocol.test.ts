import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BenchmarkResultV1Schema,
  ProtocolMetricSchema,
  RefusalSchema,
  RunEventV1Schema,
  RunJobV1Schema,
} from "../src/protocol.ts";
import {
  METRIC_ROLES,
  collapseRepeatedRunEvents,
  LocalRunEventBatchSchema,
  LocalRunEventSchema,
  StartLocalRunRequestSchema,
} from "../src/schema.ts";

const fixtureRoot = fileURLToPath(new URL("../../../protocols/v1/fixtures/", import.meta.url));

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixtureRoot}${name}`, "utf8"));
}

test("TypeScript contracts accept all valid v1 golden fixtures", async () => {
  assert.equal(RunJobV1Schema.safeParse(await fixture("run-job.valid.json")).success, true);
  assert.equal(
    BenchmarkResultV1Schema.safeParse(await fixture("benchmark-result.valid.json")).success,
    true,
  );
  assert.equal(RunEventV1Schema.safeParse(await fixture("run-event.valid.json")).success, true);
  // A result from a repository that declared nothing, so the platform found
  // its functions by running them and reports which ones it chose.
  assert.equal(
    BenchmarkResultV1Schema.safeParse(await fixture("benchmark-result.discovered.valid.json"))
      .success,
    true,
  );
});

test("weight manifests require digests and prepared jobs may omit them", async () => {
  const practice = (await fixture("run-job.valid.json")) as Record<string, unknown>;
  const weights = practice.weights as Array<Record<string, unknown>>;
  weights[0].sha256 = "G".repeat(64);
  assert.equal(RunJobV1Schema.safeParse(practice).success, false);

  const prepared = (await fixture("run-job.valid.json")) as Record<string, unknown>;
  prepared.mode = "official";
  prepared.preparedArtifactId = "snapshot_1";
  delete prepared.weights;
  assert.equal(RunJobV1Schema.safeParse(prepared).success, true);
});

test("benchmark results may omit weights supplied when a snapshot was reused", async () => {
  const result = (await fixture("benchmark-result.valid.json")) as Record<string, unknown>;
  delete result.weightsSupplied;
  assert.equal(BenchmarkResultV1Schema.safeParse(result).success, true);
});

test("the checked-in JSON Schema accepts everything the Zod schema does", async () => {
  // protocols/v1/*.json is the contract an external runner validates against,
  // and nothing regenerates it from the Zod schemas. It sets
  // additionalProperties: false, so a field added on one side and forgotten
  // on the other is not a drift that shows up later; it is an outright
  // rejection of a valid result.
  const schema = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../protocols/v1/benchmark-result.schema.json", import.meta.url)),
      "utf8",
    ),
  ) as { properties: Record<string, unknown>; required: string[] };

  const zodKeys = Object.keys(BenchmarkResultV1Schema.shape).sort();
  assert.deepEqual(Object.keys(schema.properties).sort(), zodKeys);

  // Required must match too. A field the JSON Schema demands and Zod treats as
  // optional refuses a result the platform considers valid.
  const zodRequired = zodKeys
    .filter((key) => !BenchmarkResultV1Schema.shape[key as keyof typeof BenchmarkResultV1Schema.shape].isOptional())
    .sort();
  assert.deepEqual([...schema.required].sort(), zodRequired);
});

test("the run-job JSON Schema required fields match the Zod schema", async () => {
  const schema = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../protocols/v1/run-job.schema.json", import.meta.url)),
      "utf8",
    ),
  ) as { properties: Record<string, unknown>; required: string[] };
  const zodKeys = Object.keys(RunJobV1Schema.shape).sort();
  const zodRequired = zodKeys
    .filter((key) => !RunJobV1Schema.shape[key as keyof typeof RunJobV1Schema.shape].isOptional())
    .sort();

  assert.deepEqual(Object.keys(schema.properties).sort(), zodKeys);
  assert.deepEqual([...schema.required].sort(), zodRequired);
});

test("the run-event JSON Schema knows every field a refusal may carry", async () => {
  // Same drift as above and the same consequence: run-event.schema.json sets
  // additionalProperties: false on the refusal, so a field added to
  // RefusalSchema and forgotten here makes an external runner reject a
  // perfectly good refusal and the student sees the capped log line instead.
  const schema = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../protocols/v1/run-event.schema.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    oneOf: {
      properties?: { failure?: { properties?: { refusal?: { properties: Record<string, unknown> } } } };
    }[];
  };

  const refusal = schema.oneOf
    .map((variant) => variant.properties?.failure?.properties?.refusal)
    .find((entry) => entry !== undefined);

  assert.ok(refusal, "the failed-event variant should describe a refusal");
  assert.deepEqual(
    Object.keys(refusal.properties).sort(),
    Object.keys(RefusalSchema.shape).sort(),
  );
});

test("a refusal stored before the error report existed still parses", () => {
  // Every run that failed before today is in the database without these three
  // fields. Defaulting them to empty is what keeps those pages rendering
  // their headline rather than failing the parse and showing nothing.
  const parsed = RefusalSchema.parse({
    status: "not_wired",
    headline: "Nothing in your repository accepted the input the descriptors step passes.",
  });

  assert.deepEqual(parsed.notes, []);
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.errors, []);
});

test("TypeScript contracts reject incompatible or incomplete events", async () => {
  assert.equal(RunEventV1Schema.safeParse(await fixture("run-event.invalid.json")).success, false);
});

test("local live-run contracts accept bounded progress and reject invented phases", () => {
  assert.equal(
    StartLocalRunRequestSchema.parse({
      clientRunId: `localrun_${"b".repeat(32)}`,
      benchmarkId: "vision-recognition",
      benchmarkVersion: 1,
      repositoryId: 42,
      repositoryFullName: "cogworks/team-repo",
      sha: "a".repeat(40),
      dirty: false,
    }).repositoryFullName,
    "cogworks/team-repo",
  );
  assert.equal(
    LocalRunEventSchema.parse({
      type: "progress",
      eventId: "localevent_12345678",
      sequence: 2,
      occurredAt: Date.now(),
      phase: "evaluating",
    }).type,
    "progress",
  );
  assert.throws(() =>
    LocalRunEventSchema.parse({
      type: "progress",
      eventId: "localevent_12345678",
      sequence: 3,
      occurredAt: Date.now(),
      phase: "uploading_source",
    }),
  );
});

test("terminal flush batches require a bounded, strictly ordered event history", () => {
  const event = (sequence: number) => ({
    type: "progress" as const,
    eventId: `localevent_${String(sequence).padStart(8, "0")}`,
    sequence,
    occurredAt: Date.now(),
    phase: "evaluating" as const,
    code: "evaluation.progress" as const,
    progress: { current: sequence, total: 100, unit: "cases" as const },
  });
  assert.equal(LocalRunEventBatchSchema.parse({ events: [event(1), event(2)] }).events.length, 2);
  assert.throws(() => LocalRunEventBatchSchema.parse({ events: [event(2), event(1)] }));
  assert.throws(() =>
    LocalRunEventBatchSchema.parse({ events: Array.from({ length: 33 }, (_, i) => event(i)) }),
  );
  assert.throws(() =>
    LocalRunEventBatchSchema.parse({
      events: [
        {
          type: "failed",
          eventId: "localevent_failed",
          sequence: 1,
          occurredAt: Date.now(),
          phase: "evaluating",
          code: "run.failed.runtime",
        },
        event(2),
      ],
    }),
  );
});

test("realtime projections coalesce unchanged heartbeats without losing transitions", () => {
  const event = (sequence: number, current: number, phase = "evaluating") => ({
    eventId: `stream_event_${sequence}`,
    source: "local" as const,
    sourceRunId: "localrun_123",
    sourceSequence: sequence,
    phase,
    code: "evaluation.progress" as const,
    occurredAt: Date.now() + sequence,
    elapsedMs: sequence * 2_000,
    progress: { current, total: 40, unit: "cases" as const },
  });
  const collapsed = collapseRepeatedRunEvents([
    event(1, 0),
    event(2, 0),
    event(3, 0, "scoring"),
    event(4, 40),
  ]);
  assert.deepEqual(collapsed.map((item) => item.sourceSequence), [2, 3, 4]);
});

test("the two role lists stay in step", () => {
  // ProtocolMetricSchema decides what the runner callback may send and what
  // the portal stores; MetricSchema decides what the browser accepts back.
  // They are separate literals because protocol.ts cannot import schema.ts
  // under both Node's type stripping and the portal's tsconfig. A role added
  // to one and not the other is accepted, written to run_metrics, and then
  // rejected on read, which fails the whole run-detail request rather than
  // one metric.
  const wire = ProtocolMetricSchema.shape.role.unwrap().options;
  assert.deepEqual([...wire].sort(), [...METRIC_ROLES].sort());
});
