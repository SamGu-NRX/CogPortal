import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUN_PHASES,
  RUN_STATUSES,
  isTerminal,
  type Benchmark,
} from "@cogworks/contracts/schema";
import {
  COURSE_ORDER,
  MODULE_ACCENT,
  courseIndex,
  pickDefaultTrack,
  resolveTrack,
  sortTracks,
} from "../src/lib/track.ts";
import {
  currentPhaseIndex,
  PHASE_LABELS,
  statusTone,
  STATUS_LABELS,
} from "../src/lib/run-meta.ts";

function bench(id: string, module: Benchmark["module"]): Benchmark {
  return {
    id,
    version: 1,
    contractVersion: "cogworks.submissions.v1",
    entryPointName: id,
    title: id,
    module,
    summary: `${id} summary`,
    active: true,
    pluginVersion: "0.1.0",
    datasetVersion: "1.0.0",
    scorerVersion: "1.0.0",
    runtimeVersion: "1.0.0",
  };
}

test("sortTracks orders benchmarks by course order, then id", () => {
  const input = [
    bench("language-structures", "language"),
    bench("audio-tone-detection", "audio"),
    bench("vision-clustering", "vision"),
    bench("vision-recognition", "vision"),
    bench("audio-listening", "audio"),
  ];
  const sorted = sortTracks(input);
  assert.deepEqual(sorted.map((b) => b.id), [
    "audio-listening",
    "audio-tone-detection",
    "vision-clustering",
    "vision-recognition",
    "language-structures",
  ]);
});

test("sortTracks leaves the caller's array in its original order", () => {
  const input = [
    bench("vision-clustering", "vision"),
    bench("audio-listening", "audio"),
  ];
  sortTracks(input);
  assert.deepEqual(
    input.map((b) => b.id),
    ["vision-clustering", "audio-listening"],
  );
});

test("courseIndex ranks known modules in course order and sends unknown ones last", () => {
  assert.equal(courseIndex("audio"), 0);
  assert.equal(courseIndex("vision"), 1);
  assert.equal(courseIndex("language"), 2);
  // A Worker row with a module this build has never heard of must sort
  // after every known module, not crash the comparator.
  assert.equal(courseIndex("databases"), COURSE_ORDER.length);
});

test("an empty benchmark list yields no tracks and no default", () => {
  assert.deepEqual(sortTracks([]), []);
  assert.equal(pickDefaultTrack([]), undefined);
  assert.equal(resolveTrack([], null), undefined);
});

test("pickDefaultTrack picks the only benchmark when there is one", () => {
  const only = bench("audio-listening", "audio");
  assert.equal(pickDefaultTrack([only]), only);
});

test("pickDefaultTrack takes the newest module, first benchmark within it", () => {
  const audio = bench("audio-listening", "audio");
  const clustering = bench("vision-clustering", "vision");
  const recognition = bench("vision-recognition", "vision");
  const language = bench("language-structures", "language");
  // Mirrors the hook: tracks arrive already ordered by sortTracks. The
  // newest module is the last in course order, so language wins here even
  // though the ids would sort vision benchmarks between the two.
  const tracks = sortTracks([language, clustering, recognition, audio]);
  assert.equal(pickDefaultTrack(tracks), language);
});

test("two benchmarks in one module break the tie by id before the default picks", () => {
  const clustering = bench("vision-clustering", "vision");
  const recognition = bench("vision-recognition", "vision");
  const tracks = sortTracks([clustering, recognition]);
  assert.deepEqual(
    tracks.map((b) => b.id),
    // localeCompare sorts clustering before recognition.
    ["vision-clustering", "vision-recognition"],
  );
  assert.equal(pickDefaultTrack(tracks), clustering);
});

test("resolveTrack honors a stored id and falls back when it is stale", () => {
  const audio = bench("audio-listening", "audio");
  const recognition = bench("vision-recognition", "vision");
  const tracks = [audio, recognition];

  assert.equal(resolveTrack(tracks, "audio-listening"), audio);

  // A stored id for a benchmark that is no longer active (not in the list)
  // falls back to the default instead of hiding the dashboard.
  assert.equal(resolveTrack(tracks, "retired-benchmark"), recognition);

  // A stored id matching nothing at all does the same.
  assert.equal(resolveTrack(tracks, "vision-clustering"), recognition);

  // Nothing stored: default.
  assert.equal(resolveTrack(tracks, null), recognition);
});

test("PHASE_LABELS covers exactly the run phases", () => {
  assert.deepEqual(Object.keys(PHASE_LABELS).sort(), [...RUN_PHASES].sort());
  for (const [phase, label] of Object.entries(PHASE_LABELS)) {
    assert.ok(label.length > 0, `PHASE_LABELS[${phase}] is empty`);
  }
});

test("STATUS_LABELS covers exactly the run statuses", () => {
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...RUN_STATUSES].sort());
  for (const [status, label] of Object.entries(STATUS_LABELS)) {
    assert.ok(label.length > 0, `STATUS_LABELS[${status}] is empty`);
  }
});

test("statusTone is total over every run status", () => {
  for (const status of RUN_STATUSES) {
    const tone = statusTone(status);
    assert.ok(
      tone === "live" || tone === "good" || tone === "bad" || tone === "muted",
      `statusTone(${status}) returned ${tone}`,
    );
  }
  assert.equal(statusTone("succeeded"), "good");
  assert.equal(statusTone("failed"), "bad");
  assert.equal(statusTone("cancelled"), "muted");
  for (const phase of RUN_PHASES) {
    assert.equal(statusTone(phase), "live", `non-terminal ${phase} should be live`);
  }
});

test("currentPhaseIndex covers every status with failedPhase null and set", () => {
  for (const status of RUN_STATUSES) {
    if (status === "failed") {
      // Failed is the one terminal status where failedPhase matters.
      assert.equal(
        currentPhaseIndex(status, null),
        RUN_PHASES.length,
        "failed without a known phase sits past the last phase",
      );
      assert.equal(
        currentPhaseIndex(status, "scoring"),
        RUN_PHASES.indexOf("scoring"),
        "failed must honor the phase it failed in",
      );
    } else if (isTerminal(status)) {
      assert.equal(
        currentPhaseIndex(status, null),
        RUN_PHASES.length,
        `${status} sits past the last phase`,
      );
      assert.equal(
        currentPhaseIndex(status, "scoring"),
        RUN_PHASES.length,
        `${status} must ignore failedPhase`,
      );
    } else {
      // Non-terminal statuses are themselves phases, so the run sits at
      // its own rail position and a failedPhase value must not move it.
      assert.equal(currentPhaseIndex(status), RUN_PHASES.indexOf(status));
      assert.equal(
        currentPhaseIndex(status, "scoring"),
        RUN_PHASES.indexOf(status),
        `non-terminal ${status} must ignore failedPhase`,
      );
    }
  }
});

test("currentPhaseIndex places a failed run at the phase it failed in", () => {
  assert.equal(currentPhaseIndex("failed", null), RUN_PHASES.length);
  assert.equal(currentPhaseIndex("failed", undefined), RUN_PHASES.length);
  for (const phase of RUN_PHASES) {
    assert.equal(currentPhaseIndex("failed", phase), RUN_PHASES.indexOf(phase));
  }
});

test("MODULE_ACCENT covers exactly the three modules", () => {
  assert.deepEqual(Object.keys(MODULE_ACCENT).sort(), [
    "audio",
    "language",
    "vision",
  ]);
  for (const [module, accent] of Object.entries(MODULE_ACCENT)) {
    assert.ok(accent.label.length > 0, `MODULE_ACCENT[${module}].label is empty`);
    assert.ok(accent.tick.length > 0, `MODULE_ACCENT[${module}].tick is empty`);
    assert.ok(accent.text.length > 0, `MODULE_ACCENT[${module}].text is empty`);
  }
});
