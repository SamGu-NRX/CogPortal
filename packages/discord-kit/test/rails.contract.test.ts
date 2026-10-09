import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import { emojiFormatter, type EmojiFormatter, type EmojiName } from "../src/emoji.ts";
import { stageRail } from "../src/rails.ts";

const STAGES = ["local", "hosted", "official", "published"] as const;
const STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;

type Stage = (typeof STAGES)[number];
type Status = (typeof STATUSES)[number];
type StageState = "done" | "active" | "failed" | "pending";

const SEP = "\u2002\u2002";
const GLYPH: Record<StageState, string> = { done: "✓", active: "●", failed: "×", pending: "○" };
const EMOJI_NAME: Record<StageState, EmojiName> = {
  done: "cog_done",
  active: "cog_active",
  failed: "cog_fail",
  pending: "cog_pend",
};

function snapshot(overrides: Partial<RunSurfaceSnapshot> = {}): RunSurfaceSnapshot {
  return {
    id: `surface_${"a".repeat(20)}`,
    team: { id: "team-1", name: "Analytical Engines" },
    benchmark: { id: "vision-recognition", version: 1, title: "Vision Recognition" },
    actor: { login: "ada", name: "Ada" },
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    branch: "main",
    dirty: false,
    stage: "local",
    status: "running",
    phase: "evaluating",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_008_000,
    finishedAt: null,
    elapsedMs: 8_000,
    progress: { current: 18, total: 40, unit: "cases" },
    primaryMetric: null,
    metrics: [],
    teamBest: null,
    localRunId: "run_1",
    practiceRunId: null,
    officialRunId: null,
    published: false,
    nextOfficialAttempt: 2,
    events: [],
    actions: ["open_console", "open_portal"],
    simulated: true,
    ...overrides,
  };
}

const fallbackFmt = emojiFormatter(undefined, {});

// Recording formatter: every requested emoji name lands in `requested` in order
// and renders as a distinctive token, so the inline emoji path is asserted
// directly instead of hidden behind the fallback glyphs.
function recordingFmt(): { fmt: EmojiFormatter; requested: EmojiName[] } {
  const requested: EmojiName[] = [];
  const fmt: EmojiFormatter = (name) => {
    requested.push(name);
    return `<${name}>`;
  };
  return { fmt, requested };
}

// Independent reimplementation of the rail contract, written from the docs
// rather than the source: published seals every stage done, stages before the
// active one are done, the active stage reports the run status, and later
// stages stay pending.
function expectedPairs(stage: Stage, status: Status, published: boolean): Array<[Stage, StageState]> {
  const activeIndex = STAGES.indexOf(stage);
  return STAGES.map((candidate, index): [Stage, StageState] => {
    let state: StageState;
    if (published || index < activeIndex) state = "done";
    else if (index > activeIndex) state = "pending";
    else if (status === "succeeded") state = "done";
    else if (status === "failed") state = "failed";
    else if (status === "cancelled") state = "pending";
    else state = "active";
    return [candidate, state];
  });
}

function render(pairs: Array<[Stage, StageState]>, mark: (state: StageState) => string): string {
  return pairs.map(([stage, state]) => `${mark(state)} ${stage}`).join(SEP);
}

test("rail pins the running local stage as the only active mark", () => {
  const snap = snapshot();
  const fallback = `● local${SEP}○ hosted${SEP}○ official${SEP}○ published`;
  assert.equal(stageRail(snap, fallbackFmt, "subtext"), `-# ${fallback}`);
  assert.equal(stageRail(snap, fallbackFmt), fallback);
  const { fmt, requested } = recordingFmt();
  assert.equal(
    stageRail(snap, fmt),
    `<cog_active> local${SEP}<cog_pend> hosted${SEP}<cog_pend> official${SEP}<cog_pend> published`,
  );
  assert.deepEqual(requested, ["cog_active", "cog_pend", "cog_pend", "cog_pend"]);
});

test("rail pins a succeeded hosted stage with official still pending", () => {
  const snap = snapshot({ stage: "hosted", status: "succeeded" });
  const fallback = `✓ local${SEP}✓ hosted${SEP}○ official${SEP}○ published`;
  assert.equal(stageRail(snap, fallbackFmt, "subtext"), `-# ${fallback}`);
  assert.equal(stageRail(snap, fallbackFmt), fallback);
  const { fmt } = recordingFmt();
  assert.equal(
    stageRail(snap, fmt),
    `<cog_done> local${SEP}<cog_done> hosted${SEP}<cog_pend> official${SEP}<cog_pend> published`,
  );
});

test("rail pins a failed official stage without claiming published", () => {
  const snap = snapshot({ stage: "official", status: "failed" });
  const fallback = `✓ local${SEP}✓ hosted${SEP}× official${SEP}○ published`;
  assert.equal(stageRail(snap, fallbackFmt, "subtext"), `-# ${fallback}`);
  assert.equal(stageRail(snap, fallbackFmt), fallback);
  const { fmt } = recordingFmt();
  assert.equal(
    stageRail(snap, fmt),
    `<cog_done> local${SEP}<cog_done> hosted${SEP}<cog_fail> official${SEP}<cog_pend> published`,
  );
});

test("rail pins the published seal over every stage", () => {
  const snap = snapshot({ stage: "published", status: "succeeded", published: true });
  const fallback = `✓ local${SEP}✓ hosted${SEP}✓ official${SEP}✓ published`;
  assert.equal(stageRail(snap, fallbackFmt, "subtext"), `-# ${fallback}`);
  assert.equal(stageRail(snap, fallbackFmt), fallback);
  const { fmt } = recordingFmt();
  assert.equal(
    stageRail(snap, fmt),
    `<cog_done> local${SEP}<cog_done> hosted${SEP}<cog_done> official${SEP}<cog_done> published`,
  );
});

test("rail leaves a cancelled run unclaimed", () => {
  const snap = snapshot({ status: "cancelled", phase: "cancelled" });
  const fallback = `○ local${SEP}○ hosted${SEP}○ official${SEP}○ published`;
  assert.equal(stageRail(snap, fallbackFmt, "subtext"), `-# ${fallback}`);
  assert.equal(stageRail(snap, fallbackFmt), fallback);
  const { fmt } = recordingFmt();
  assert.equal(
    stageRail(snap, fmt),
    `<cog_pend> local${SEP}<cog_pend> hosted${SEP}<cog_pend> official${SEP}<cog_pend> published`,
  );
});

test("rail defaults to the inline variant", () => {
  const snap = snapshot({ stage: "hosted" });
  assert.equal(stageRail(snap, fallbackFmt), stageRail(snap, fallbackFmt, "inline"));
});

test("rail matches the contract across every stage, status, and published flag", () => {
  for (const stage of STAGES) {
    for (const status of STATUSES) {
      for (const published of [false, true]) {
        const snap = snapshot({ stage, status, published });
        const expected = expectedPairs(stage, status, published);
        const label = `${stage}/${status}/published=${published}`;
        assert.equal(
          stageRail(snap, fallbackFmt, "subtext"),
          `-# ${render(expected, (state) => GLYPH[state])}`,
          `subtext ${label}`,
        );
        assert.equal(stageRail(snap, fallbackFmt), render(expected, (state) => GLYPH[state]), `inline ${label}`);
        const { fmt } = recordingFmt();
        assert.equal(
          stageRail(snap, fmt),
          render(expected, (state) => `<${EMOJI_NAME[state]}>`),
          `inline emoji ${label}`,
        );
      }
    }
  }
});
