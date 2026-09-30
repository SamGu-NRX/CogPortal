import type { RunLifecycleStageState, RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import { runSurfaceStageStates } from "@cogworks/contracts/schema";
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

type StageState = "done" | "active" | "failed" | "pending";

// A stopped run can be retried, so the rail keeps it open rather than failed.
const RAIL_STATE: Record<Exclude<RunLifecycleStageState, "not_run">, StageState> = {
  complete: "done",
  active: "active",
  failed: "failed",
  cancelled: "pending",
  pending: "pending",
};

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
  const states = runSurfaceStageStates(snapshot);
  // A stage this run never entered, such as local for a run started in the
  // browser, has no mark to show, so the rail names only the stages it had.
  const parts = STAGES.flatMap((stage) => {
    const state = states[stage];
    if (state === "not_run") return [];
    const mark = variant === "subtext" ? GLYPHS[RAIL_STATE[state]] : fmt(EMOJI[RAIL_STATE[state]]);
    return [`${mark} ${stage}`];
  });
  const line = parts.join(META_SEP);
  return variant === "subtext" ? `-# ${line}` : line;
}
