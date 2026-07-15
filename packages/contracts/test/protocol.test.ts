import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BenchmarkResultV1Schema,
  RunEventV1Schema,
  RunJobV1Schema,
} from "../src/protocol.ts";
import { LocalRunEventSchema, StartLocalRunRequestSchema } from "../src/schema.ts";

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
