import type { RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import type { EmojiFormatter } from "./emoji.ts";
import { META_SEP } from "./format.ts";

/**
 * The lifecycle footer rail: quiet provenance, not a headline. Lowercase
 * labels, marks carrying the state, en-space separation, no middots.
 *
 * Two treatments exist pending the visual gate:
 * - "subtext": a `-#` line with font glyphs, which scale with the small text.
 * - "inline": a full-size line with the custom emoji marks.
 */
export type RailVariant = "subtext" | "inline";

const STAGES = ["local", "hosted", "official", "published"] as const;

type Stage = (typeof STAGES)[number];

type StageState = "done" | "active" | "failed" | "pending";

// Exhaustive on purpose: when a stage is added to the schema without updating
// this rail, indexing STAGE_INDEX stops compiling instead of indexOf silently
// returning -1 and marking every stage pending.
const STAGE_INDEX: Record<(typeof STAGES)[number], number> = {
  local: 0,
  hosted: 1,
  official: 2,
  published: 3,
};

function stageState(index: number, active: number, snapshot: RunSurfaceSnapshot): StageState {
  if (index < active || (index === active && snapshot.status === "succeeded") || snapshot.published) {
    return "done";
  }
  if (index === active && snapshot.status === "failed") return "failed";
  if (index === active && snapshot.status === "cancelled") return "pending";
  if (index === active) return "active";
  return "pending";
}

function stageStates(snapshot: RunSurfaceSnapshot): Array<[Stage, StageState]> {
  const active = STAGE_INDEX[snapshot.stage];
  return STAGES.map((stage, index): [Stage, StageState] => [stage, stageState(index, active, snapshot)]);
}

const GLYPHS: Record<StageState, string> = { done: "✓", active: "●", failed: "×", pending: "○" };
const EMOJI: Record<StageState, "cog_done" | "cog_active" | "cog_fail" | "cog_pend"> = {
  done: "cog_done",
  active: "cog_active",
  failed: "cog_fail",
  pending: "cog_pend",
};

export function stageRail(
  snapshot: RunSurfaceSnapshot,
  fmt: EmojiFormatter,
  variant: RailVariant = "inline",
): string {
  const parts = stageStates(snapshot).map(([stage, state]) => {
    const mark = variant === "subtext" ? GLYPHS[state] : fmt(EMOJI[state]);
    return `${mark} ${stage}`;
  });
  const line = parts.join(META_SEP);
  return variant === "subtext" ? `-# ${line}` : line;
}
