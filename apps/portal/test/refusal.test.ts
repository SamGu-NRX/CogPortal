import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { benchmarks, cohorts, runs, runSurfaces, teams, users } from "../worker/db/schema.ts";
import type { Env } from "../worker/env.ts";
import { buildRunSurfaceSnapshot } from "../worker/services/run-surfaces.ts";
import { WiringTrace } from "../src/components/WiringTrace.tsx";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { RunEventV1Schema } from "@cogworks/contracts/protocol";
import { RunDetailSchema } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { FailureCard } from "../src/components/FailureCard.tsx";
import {
  RefusalCard,
  errorClass,
  refusalFix,
  stageFromHeadline,
  type Refusal,
} from "../src/components/RefusalCard.tsx";

/**
 * A run can fail because a team's algorithm crashed, which has a traceback and
 * belongs in the log, or because nothing in the repository performed the
 * week's task, which has no traceback at all. The second used to reach a
 * student as one capped line naming our own sandbox script.
 */

const refusal = {
  status: "not_wired",
  headline:
    "Nothing in your repository took a tuple of 2, starting with an array of shape (1025, 171) for the fingerprints step, which is what audio_parser.spectrogram_conversion returned.",
  nextStep:
    "fingerprint_database and fingerprint_maker did not import, because ipynb is not installed here.",
  trace: [{ stage: "spectrogram", function: "audio_parser.spectrogram_conversion" }],
};

test("a failed event may carry the whole verdict, not only a capped line", () => {
  const event = {
    protocolVersion: "1",
    eventId: "event_1",
    runId: "run_1",
    sequence: 1,
    occurredAt: 1,
    type: "failed",
    failure: {
      category: "adapter_missing",
      phase: "contract_check",
      detail: "No adapter found in their-repo.",
      infrastructure: false,
      refusal,
    },
  };

  const parsed = RunEventV1Schema.safeParse(event);
  assert.equal(parsed.success, true);
});

test("an older runner that sends no refusal is still valid", () => {
  const event = {
    protocolVersion: "1",
    eventId: "event_1",
    runId: "run_1",
    sequence: 1,
    occurredAt: 1,
    type: "failed",
    failure: {
      category: "timeout",
      phase: "evaluating",
      detail: "Timed out.",
      infrastructure: false,
    },
  };

  assert.equal(RunEventV1Schema.safeParse(event).success, true);
});

test("a run detail without a refusal reads as null rather than absent", () => {
  const parsed = RunDetailSchema.shape.refusal.safeParse(undefined);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data, null);
});

test("the headline is allowed to be longer than a log line", () => {
  // The old cap was 240 characters, which cut a refusal mid-sentence right
  // where it started naming the modules that could not be read.
  const schema = RunDetailSchema.shape.refusal;
  assert.equal(schema.safeParse({ ...refusal, headline: "h".repeat(600) }).success, true);
  assert.equal(schema.safeParse({ ...refusal, headline: "h".repeat(601) }).success, false);
});

test("a refusal stored before the error report existed still renders", () => {
  // Every run that failed before today is in the database without these three
  // fields, and the run page reads them unconditionally. Defaulting to empty
  // is what keeps those pages showing their headline instead of nothing.
  const parsed = RunDetailSchema.shape.refusal.safeParse(refusal);

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data?.notes, []);
  assert.deepEqual(parsed.success && parsed.data?.skipped, []);
  assert.deepEqual(parsed.success && parsed.data?.errors, []);
});

test("the run page receives skipped files and raised lines as structure", () => {
  // Not prose. The card prints file, line, and message in their own columns,
  // and the owner decides whether a skip is named as theirs at all.
  const parsed = RunDetailSchema.shape.refusal.safeParse({
    ...refusal,
    notes: ["clustering.clusterCreator() reads baseImages/ next to its own file."],
    skipped: [{ module: "master", reason: "is empty", owner: "theirs" }],
    errors: [
      {
        file: "whispers.py",
        line: 66,
        function: "whispers.create_graph",
        message: "AttributeError: module 'pyexpat.model' has no attribute 'detect'",
      },
    ],
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data?.errors[0]?.line, 66);
  assert.equal(parsed.success && parsed.data?.skipped[0]?.owner, "theirs");
});

test("the adapter failure no longer tells a team to write packaging metadata", () => {
  // Zero of the thirteen 2026 capstones has a pyproject.toml, and the
  // platform no longer needs one. Sending a team to write an entry point
  // would cost them an afternoon on the wrong problem.
  const copy = FAILURE_CATALOG.adapter_missing;

  assert.ok(!copy.action.includes("pyproject.toml"));
  assert.ok(!copy.action.includes("entry-points"));
  assert.ok(copy.reproCommand.includes("cogworks check"));
});

/* ── The card ────────────────────────────────────────────────────────────
 *
 * A refusal is printed as a label column and one observation per row. The
 * assertions below are about which rows exist, because that is the part a
 * payload decides: a row whose field is absent is omitted rather than filled,
 * and the fix line is templated from the exception class alone.
 */

const wired = {
  status: "not_wired",
  // Verbatim from cogbench.verdict's no-trace branch
  // (python/cogbench/src/cogbench/verdict.py:397).
  headline:
    "Nothing in your repository accepted the input the database step passes.",
  nextStep: "",
  trace: [
    {
      stage: "fingerprints",
      function: "newtons_code.create_fingerprints",
      returned: "a dict of 4102 keys",
    },
  ],
  notes: ["clustering.clusterCreator() reads baseImages/ next to its own file."],
  skipped: [
    {
      module: "Code",
      reason: "RuntimeError: microphone.record_audio is not available here",
      owner: "theirs",
    },
    { module: "master", reason: "is empty", owner: "theirs" },
    { module: "will_is_not_locked_bro", reason: "FileNotFoundError: 'song_list'", owner: "theirs" },
  ],
  errors: [
    {
      file: "whispers.py",
      line: 66,
      function: "whispers.create_graph",
      message: "AttributeError: module 'pyexpat.model' has no attribute 'detect'",
    },
  ],
};

function card(value: Refusal, stage?: string): string {
  return renderToStaticMarkup(
    React.createElement(RefusalCard, {
      refusal: value,
      benchmarkId: "audio-identification",
      stage,
    }),
  );
}

function rowLabels(html: string): string[] {
  return [...html.matchAll(/<dt[^>]*>([^<]*)</g)].map((match) => match[1]!);
}

test("only the rows the payload can fill are printed", () => {
  // The mock layout has `expected` and `found` rows naming the shape the run
  // wanted next and how many modules it searched. Neither is a field on the
  // refusal, so neither row exists rather than being filled with a guess.
  assert.deepEqual(rowLabels(card(wired, "Contract check")), [
    "after",
    "not read",
    "raised",
    "next",
  ]);
});

test("a refusal that observed nothing still names the one command to run", () => {
  const bare = { ...wired, trace: [], skipped: [], errors: [] };

  const html = card(bare);
  assert.deepEqual(rowLabels(html), ["next"]);
  assert.match(html, /--update-setup/);
  assert.match(html, /audio-identification/);
});

test("the headline leads and the notes are gone", () => {
  // The headline stays because it is the only place the stage the run wanted
  // is named. The notes went: each one restated a row below it.
  const html = card(wired, "Contract check");

  assert.doesNotMatch(html, /WHAT THE BENCHMARK LOOKED FOR/);
  assert.doesNotMatch(html, /clusterCreator/);
  assert.match(html, /Nothing in your repository accepted the input/);
});

test("the header names the stage the headline names, not the run phase", () => {
  const html = card(wired, "Contract check");

  assert.match(html, /at <span class="text-ink">database<\/span>/);
  assert.doesNotMatch(html, /Contract check/);
});

test("a headline that names no stage leaves the header on the run phase", () => {
  const html = card({ ...wired, headline: "" }, "Contract check");

  assert.match(html, /Contract check/);
});

test("the stage is read out of both verdict wordings, and nothing else", () => {
  // Both forms cogbench.verdict writes for not_wired
  // (python/cogbench/src/cogbench/verdict.py:389 and :397).
  assert.equal(
    stageFromHeadline(
      "Nothing in your repository accepted the input the database step passes.",
    ),
    "database",
  );
  assert.equal(
    stageFromHeadline(
      "Nothing in your repository took a list of 4102 tuples for the database " +
        "step, which is what newtons_code.create_fingerprints returned.",
    ),
    "database",
  );
  // A verdict of another shape gets no guess; the header falls back instead.
  assert.equal(
    stageFromHeadline("Nothing in this repository performed the week's task."),
    null,
  );
  assert.equal(stageFromHeadline(""), null);
});

test("a fix line appears only for a class that has one", () => {
  const html = card(wired, "Contract check");

  assert.match(html, /move the microphone call out of module scope/);
  assert.match(html, /open the file inside the function, not at import/);
  // Two fixes for three unread modules: the empty one gets none.
  assert.equal(html.match(/>fix</g)?.length, 2);
});

test("an import-time RuntimeError about the microphone gets the one fix that applies", () => {
  assert.equal(
    refusalFix("RuntimeError: microphone.record_audio is not available here"),
    "move the microphone call out of module scope",
  );
  assert.equal(
    refusalFix("RuntimeError: cannot record without an input device"),
    "move the microphone call out of module scope",
  );
});

test("a missing file at import time gets the import-scope fix", () => {
  assert.equal(
    refusalFix("FileNotFoundError: 'song_list'"),
    "open the file inside the function, not at import",
  );
});

test("every other reason gets no fix line at all", () => {
  // A wrong fix sends a team somewhere; an absent one leaves them reading the
  // exception, which is the thing that is actually true.
  assert.equal(refusalFix("is empty"), null);
  assert.equal(refusalFix("ImportError: No module named 'ipynb'"), null);
  assert.equal(refusalFix("AttributeError: 'NoneType' object has no attribute 'record'"), null);
  assert.equal(refusalFix("RuntimeError: shapes (2,) and (3,) are not aligned"), null);
  assert.equal(refusalFix(""), null);
});

test("the exception class is read off the head of the line, or not at all", () => {
  assert.equal(errorClass("FileNotFoundError: 'song_list'"), "FileNotFoundError");
  assert.equal(errorClass("AttributeError: module 'pyexpat.model' has no attribute 'detect'"), "AttributeError");
  assert.equal(errorClass("is empty"), null);
  assert.equal(errorClass("could not be read on this machine"), null);
});


test("collapsed failure copy reports attempt use only for official runs", () => {
  const failure = {
    category: "adapter_missing" as const,
    phase: "contract_check" as const,
    detail: null,
    consumedAttempt: false,
  };
  const practice = renderToStaticMarkup(
    React.createElement(FailureCard, {
      failure,
      mode: "practice",
      benchmarkId: "audio-identification",
      collapsed: true,
    }),
  );
  const official = renderToStaticMarkup(
    React.createElement(FailureCard, {
      failure,
      mode: "official",
      benchmarkId: "audio-identification",
      collapsed: true,
    }),
  );

  assert.match(practice, /E-ADAPTER · practice/);
  assert.doesNotMatch(practice, /attempt/);
  assert.match(official, /E-ADAPTER · official · attempt not consumed/);
});


test("a 601-character persisted refusal still produces a snapshot", async (t) => {
  // Use the migrated database so this checks the persisted JSON through the
  // snapshot builder and its strict schema, not just a string helper.
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((file) =>
    file.endsWith(".sql") && !/^(0002_seed|0016_backfill)/.test(file)
  ).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const binding = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: never[] = [];
      const prepared = {
        bind(...params: unknown[]) {
          bound = params as never[];
          return prepared;
        },
        async run() {
          return { success: true, meta: statement.run(...bound) };
        },
        async raw() {
          statement.setReturnArrays(true);
          return statement.all(...bound);
        },
      };
      return prepared;
    },
  };
  const db = drizzle(binding as never);
  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true,
  });
  await db.insert(users).values({
    id: "user_test", name: "Ada", email: "ada@example.test", githubLogin: "ada", cohortId: "cohort_test",
  });
  await db.insert(teams).values({
    id: "team_test", cohortId: "cohort_test", name: "Test team",
    repoOwner: "test", repoName: "test", repoFullName: "test/test",
    repoUrl: "https://github.com/test/test", defaultBranch: "main", repoId: 1,
  });
  await db.insert(benchmarks).values({
    id: "vision-recognition", version: 1, contractVersion: "cogworks.submissions.v1",
    entryPointName: "submission", title: "Vision Recognition", module: "vision",
    summary: "Test benchmark", active: true, primaryMetricKey: "accuracy", pluginVersion: "1",
    datasetVersion: "official-v1", scorerVersion: "1", runtimeVersion: "python-3.11",
  });
  const surfaceId = "surface_0a1b2c3d4e5f60718293";
  const createdAt = 1_780_000_000_000;
  await db.insert(runSurfaces).values({
    id: surfaceId, teamId: "team_test", createdByUserId: "user_test",
    benchmarkId: "vision-recognition", benchmarkVersion: 1, createdAt, updatedAt: createdAt,
  });
  const headline = "h".repeat(601);
  await db.insert(runs).values({
    id: "run_refusal", teamId: "team_test", benchmarkId: "vision-recognition", benchmarkVersion: 1,
    contractVersion: "cogworks.submissions.v1", mode: "practice", status: "failed",
    branch: "main", sha: "a".repeat(40), repositoryId: 1, provider: "modal",
    createdAt, finishedAt: createdAt + 1_000, surfaceId,
    refusalJson: JSON.stringify({ ...refusal, headline }),
  });

  const { runSurfaceHubs } = await import("./fixtures/run-surface-hub.ts");
  const runtime = { DB: binding, EXECUTION_PROVIDER: "modal" } as unknown as Env;
  runtime.RUN_SURFACES = runSurfaceHubs(runtime).namespace;
  const snapshot = await buildRunSurfaceSnapshot(runtime, surfaceId);
  assert.equal(snapshot.snapshotRevision, 1);
  assert.equal(snapshot.id, surfaceId);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.refusalHeadline, headline.slice(0, 600));
});

test("wiring keeps all 200 identifier characters and uses wrapping rather than ellipsis", () => {
  const identifier = "module." + "f".repeat(193);
  const markup = renderToStaticMarkup(React.createElement(WiringTrace, {
    steps: [{ stage: "peaks", function: identifier }],
  }));
  assert.ok(markup.includes(identifier));
  assert.match(markup, /class="break-all font-mono/);
  assert.doesNotMatch(markup, /truncate|text-ellipsis/);
});
