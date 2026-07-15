import { EMOJI_MANIFEST } from "./emoji-manifest.generated.ts";

/**
 * The custom app-emoji vocabulary: instrument marks generated from the portal
 * design tokens and uploaded to the Discord application. Every surface asks
 * for marks through a formatter so environments without a synced manifest
 * (local dev, tests, a failed sync) degrade to plain font glyphs instead of
 * rendering raw `:name:` text.
 */
export const EMOJI_NAMES = [
  "cog_spin",
  "cog_done",
  "cog_fail",
  "cog_pend",
  "cog_active",
  "cog_bar_l_0",
  "cog_bar_l_1",
  "cog_bar_m_0",
  "cog_bar_m_1",
  "cog_bar_r_0",
  "cog_bar_r_1",
  "cog_slot_used",
  "cog_slot_free",
  "cog_star",
] as const;

export type EmojiName = (typeof EMOJI_NAMES)[number];

export interface EmojiManifestEntry {
  id: string;
  animated: boolean;
  /** SHA-256 of the rendered asset, so the sync script can detect redesigns. */
  sourceHash?: string;
}

export type EmojiManifest = Record<string, Partial<Record<EmojiName, EmojiManifestEntry>>>;

/** Font glyphs stand in when no manifest covers the current application. */
const FALLBACK: Record<EmojiName, string> = {
  cog_spin: "◐",
  cog_done: "✓",
  cog_fail: "×",
  cog_pend: "○",
  cog_active: "●",
  cog_bar_l_0: "▱",
  cog_bar_l_1: "▰",
  cog_bar_m_0: "▱",
  cog_bar_m_1: "▰",
  cog_bar_r_0: "▱",
  cog_bar_r_1: "▰",
  cog_slot_used: "▮",
  cog_slot_free: "▯",
  cog_star: "✱",
};

export type EmojiFormatter = (name: EmojiName) => string;

export function emojiFormatter(
  applicationId?: string | null,
  manifest: EmojiManifest = EMOJI_MANIFEST,
): EmojiFormatter {
  const entries = applicationId ? manifest[applicationId] : undefined;
  return (name) => {
    const entry = entries?.[name];
    if (!entry) return FALLBACK[name];
    return `<${entry.animated ? "a" : ""}:${name}:${entry.id}>`;
  };
}

/**
 * A thin segmented gauge built from bar emoji (or their font fallbacks).
 * Fill is floored so the bar never claims progress that has not happened;
 * a full bar appears only when the count is actually complete.
 */
export function progressBar(
  current: number,
  total: number,
  fmt: EmojiFormatter,
  width = 8,
): string {
  const safeTotal = Math.max(1, total);
  const clamped = Math.min(Math.max(0, current), safeTotal);
  const filled = clamped >= safeTotal ? width : Math.min(width - 1, Math.floor((clamped / safeTotal) * width));
  const segments: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const position = index === 0 ? "l" : index === width - 1 ? "r" : "m";
    const state = index < filled ? 1 : 0;
    segments.push(fmt(`cog_bar_${position}_${state}` as EmojiName));
  }
  return segments.join("");
}

/** Official-attempt cells: filled marks for spent attempts, hollow for remaining. */
export function quotaCells(used: number, total: number, fmt: EmojiFormatter): string {
  const cells: string[] = [];
  for (let index = 0; index < total; index += 1) {
    cells.push(fmt(index < used ? "cog_slot_used" : "cog_slot_free"));
  }
  return cells.join("");
}
