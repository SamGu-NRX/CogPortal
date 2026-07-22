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

type StageState = "done" | "active" | "failed" | "pending";

function stageStates(snapshot: RunSurfaceSnapshot): StageState[] {
  const active = STAGES.indexOf(snapshot.stage);
  return STAGES.map((_, index) => {
    if (index < active || (index === active && snapshot.status === "succeeded") || snapshot.published) {
      return "done";
    }
    if (index === active && snapshot.status === "failed") return "failed";
    if (index === active && snapshot.status === "cancelled") return "pending";
    if (index === active) return "active";
    return "pending";
  });
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
  const states = stageStates(snapshot);
  const parts = STAGES.map((stage, index) => {
    const mark = variant === "subtext" ? GLYPHS[states[index]!] : fmt(EMOJI[states[index]!]);
    return `${mark} ${stage}`;
  });
  const line = parts.join(META_SEP);
  return variant === "subtext" ? `-# ${line}` : line;
}
