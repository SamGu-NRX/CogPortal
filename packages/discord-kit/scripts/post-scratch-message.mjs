/**
 * Posts the visual-gate scratch message: one Components V2 message that
 * exercises every rendering unknown at once, so spacing/rail/spinner
 * decisions are made against real client rendering before any layout work.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... node scripts/post-scratch-message.mjs <channel-id>
 *
 * Judge it on desktop AND mobile, dark AND light themes:
 *   1. glyph row legibility at inline size
 *   2. spinner loop taste (and its static first frame with autoplay off)
 *   3. do custom emoji scale down inside -# subtext?
 *   4. en-space vs regular-space runs (does either collapse?)
 *   5. jumbo behavior of an emoji-only line inside a text display
 *   6. footer-rail variant A (subtext + font glyphs) vs B (full-size + emoji)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID ?? "1526706029356646460";
const channelId = process.argv[2];
if (!token || !channelId) {
  console.error("Usage: DISCORD_BOT_TOKEN=... node scripts/post-scratch-message.mjs <channel-id>");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(KIT_ROOT, "emoji", "manifest.json"), "utf8"));
const entries = manifest[applicationId];
if (!entries) {
  console.error(`No manifest for application ${applicationId}; run emoji:sync first.`);
  process.exit(1);
}
const e = (name) => `<${entries[name].animated ? "a" : ""}:${name}:${entries[name].id}>`;

const EN = "\u2002";
const text = (content) => ({ type: 10, content });
const sep = { type: 14, divider: true, spacing: 1 };

const body = {
  flags: 1 << 15,
  components: [
    {
      type: 17,
      accent_color: 0x1c2637,
      components: [
        text("### Visual gate"),
        text(
          `1${EN}glyphs:  ${e("cog_spin")} ${e("cog_done")} ${e("cog_fail")} ${e("cog_pend")} ${e("cog_active")} ${e("cog_star")} ${e("cog_slot_used")}${e("cog_slot_used")}${e("cog_slot_free")}`,
        ),
        text(`2${EN}bar:  ${e("cog_bar_l_1")}${e("cog_bar_m_1")}${e("cog_bar_m_1")}${e("cog_bar_m_0")}${e("cog_bar_m_0")}${e("cog_bar_r_0")}  \`18/40\``),
        sep,
        text(`3a${EN}emoji in subtext:\n-# ${e("cog_done")} Repository ready  \`00:02\``),
        text(`3b${EN}font glyph in subtext:\n-# ○ Scoring`),
        sep,
        text(`4a${EN}regular spaces: Face Recognition  \`89353d0\`  Sam  \`0:49\`  simulated`),
        text(`4b${EN}en-spaces: Face Recognition${EN}${EN}\`89353d0\`${EN}${EN}Sam${EN}${EN}\`0:49\`${EN}${EN}simulated`),
        sep,
        text(`5${EN}jumbo test (emoji-only line):`),
        text(`${e("cog_spin")}${e("cog_done")}${e("cog_active")}`),
        sep,
        text(`6a${EN}rail, subtext + font glyphs:\n-# ✓ local${EN}${EN}● hosted${EN}${EN}○ official${EN}${EN}○ published`),
        text(`6b${EN}rail, full-size + emoji:\n${e("cog_done")} local${EN}${EN}${e("cog_active")} hosted${EN}${EN}${e("cog_pend")} official${EN}${EN}${e("cog_pend")} published`),
        sep,
        text(`7${EN}loader composition:\n${e("cog_done")} Repository ready  \`00:02\`\n${e("cog_done")} Contract passed  \`00:06\`\n${e("cog_spin")} **Evaluating**  \`18/40\`\n-# ○ Scoring`),
      ],
    },
  ],
  allowed_mentions: { parse: [] },
};

const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "DiscordBot (https://cogportal-dev.sillion.app, 1)",
  },
  body: JSON.stringify(body),
});
if (!response.ok) {
  console.error(`Failed with HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  process.exit(1);
}
const message = await response.json();
console.log(`Posted scratch message ${message.id} to channel ${channelId}.`);
