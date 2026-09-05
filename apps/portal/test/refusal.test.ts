import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FAILURE_CATALOG } from "@cogworks/contracts/failures";
import { RunEventV1Schema } from "@cogworks/contracts/protocol";
import { RunDetailSchema } from "@cogworks/contracts/schema";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

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
  assert.ok(refusal.headline.length > 140);
  assert.equal(RunDetailSchema.shape.refusal.safeParse(refusal).success, true);
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
