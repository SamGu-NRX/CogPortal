/**
 * Renders the Cog app-emoji set from SVG templates into emoji/dist/.
 *
 * Design notes, so future edits stay on-language:
 * - 128x128 canvas with generous transparent padding: glyphs occupy the center
 *   ~64-88px so they sit small and thin inline, like instrument marks, not
 *   stickers.
 * - Colors derive from the portal tokens but shifted to mid-tones; a pure-ink
 *   mark disappears on Discord's dark theme. Detector red is the "the
 *   instrument is looking here" accent; verify green only ever means observed
 *   success.
 * - The spinner is the Windows-boot grammar: a comet of five dots orbiting
 *   with non-uniform angular velocity on a seamless loop. GIF transparency is
 *   1-bit, so the trail fades by dot size, never by partial alpha.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "emoji", "dist");
const SIZE = 128;

/**
 * Mid-tone derivatives of the portal palette; readable on dark and light.
 * Color is rationed: detector red only for failure, verify green only for
 * observed success, and a calm slate for everything structural (identity
 * glyphs, the spinner, gauges) so nothing reads as flashy.
 */
const PALETTE = {
  detect: "#c63d2f",
  verify: "#3d7c5e",
  slate: "#828b9e", // structural glyphs; reads on dark and light chrome
  slateDeep: "#5a6478",
  faint: "#7d8697",
  hair: "#828b9e", // hairline outlines for empty states
};

/** Muted metal tones for the podium; gold leans on the portal's ochre. */
const MEDAL = { 1: "#b8923a", 2: "#98a1b3", 3: "#a86f4d" };

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

/**
 * Discord scales every custom emoji down to one inline size, so a glyph that
 * fills more of its canvas reads larger and bolder in a message. Marks were
 * drawn with generous padding; this scales them up about center to occupy the
 * frame. The bar-gauge cells opt out because they intentionally bleed to the
 * canvas edges to tile.
 */
const EMOJI_SCALE = 1.34;
function esvg(body) {
  return svg(`<g transform="translate(64 64) scale(${EMOJI_SCALE}) translate(-64 -64)">${body}</g>`);
}

const stroke = (color, width, extra = "") =>
  `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}`;

/** Static marks. One glyph, one meaning. */
const STATIC = {
  // Lifecycle marks
  cog_done: esvg(`<polyline points="36,68 57,88 92,42" ${stroke(PALETTE.verify, 11)} />`),
  cog_fail: esvg(
    `<line x1="42" y1="42" x2="86" y2="86" ${stroke(PALETTE.detect, 11)} />` +
      `<line x1="86" y1="42" x2="42" y2="86" ${stroke(PALETTE.detect, 11)} />`,
  ),
  cog_pend: esvg(`<circle cx="64" cy="64" r="21" ${stroke(PALETTE.faint, 7)} />`),
  cog_active: esvg(cornerBrackets(40, 40, 88, 88, 15, PALETTE.detect, 8) + `<circle cx="64" cy="64" r="9" fill="${PALETTE.slateDeep}" />`),

  // Published seal
  cog_star: esvg(
    `<circle cx="64" cy="64" r="30" ${stroke(PALETTE.verify, 7)} />` +
      asterisk(64, 64, 6, 19, PALETTE.verify, 8),
  ),

  // Official-attempt pips
  cog_slot_used: esvg(slotToken(true)),
  cog_slot_free: esvg(slotToken(false)),

  // Progress gauge cells
  cog_bar_l_1: svg(barSegment("l", true)),
  cog_bar_l_0: svg(barSegment("l", false)),
  cog_bar_m_1: svg(barSegment("m", true)),
  cog_bar_m_0: svg(barSegment("m", false)),
  cog_bar_r_1: svg(barSegment("r", true)),
  cog_bar_r_0: svg(barSegment("r", false)),

  // Menu and identity glyphs
  cog_flask: esvg(flask()),
  cog_board: esvg(board()),
  cog_notes: esvg(notes()),
  cog_link: esvg(chainLink()),
  cog_portal: esvg(portalArrow()),
  cog_vision: esvg(aperture()),
  cog_repo: esvg(gitBranch()),

  // Leaderboard rank tokens
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`cog_rank_${index + 1}`, esvg(rankToken(index + 1))]),
  ),
};

/**
 * A rank token. Ranks 1-3 are medals (ribbon + disc + knockout numeral) in
 * muted metals; 4-10 are hairline squircles so the column stays aligned but
 * the podium carries the emphasis. Numerals use the system sans at render
 * time; the committed PNGs are what ship.
 */
function rankToken(rank) {
  const label = String(rank);
  const textAt = (y, size, fill, weight) =>
    `<text x="64" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${label}</text>`;
  if (rank <= 3) {
    const metal = MEDAL[rank];
    return (
      `<path d="M46 22 L58 22 L68 46 L52 50 Z" fill="${metal}" opacity="0.55" />` +
      `<path d="M82 22 L70 22 L60 46 L76 50 Z" fill="${metal}" opacity="0.8" />` +
      `<circle cx="64" cy="74" r="28" fill="${metal}" />` +
      `<circle cx="64" cy="74" r="22" fill="none" stroke="#f7f3ea" stroke-width="3" stroke-opacity="0.55" />` +
      textAt(76, 30, "#f7f3ea", 700)
    );
  }
  const x = 36;
  const w = 56;
  return `<rect x="${x}" y="${x}" width="${w}" height="${w}" rx="16" ${stroke(PALETTE.hair, 4)} opacity="0.75" />${textAt(66, label.length > 1 ? 32 : 36, PALETTE.faint, 500)}`;
}

function cornerBrackets(x1, y1, x2, y2, arm, color, width) {
  const s = stroke(color, width);
  return (
    `<polyline points="${x1},${y1 + arm} ${x1},${y1} ${x1 + arm},${y1}" ${s} />` +
    `<polyline points="${x2 - arm},${y1} ${x2},${y1} ${x2},${y1 + arm}" ${s} />` +
    `<polyline points="${x2},${y2 - arm} ${x2},${y2} ${x2 - arm},${y2}" ${s} />` +
    `<polyline points="${x1 + arm},${y2} ${x1},${y2} ${x1},${y2 - arm}" ${s} />`
  );
}

function asterisk(cx, cy, inner, outer, color, width) {
  let rays = "";
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI / 3) * index - Math.PI / 2;
    const x1 = cx + inner * Math.cos(angle);
    const y1 = cy + inner * Math.sin(angle);
    const x2 = cx + outer * Math.cos(angle);
    const y2 = cy + outer * Math.sin(angle);
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ${stroke(color, width)} />`;
  }
  return rays;
}

/**
 * An official-attempt token. Both states share one footprint so a row of pips
 * aligns; a spent attempt is a filled squircle, a remaining one its hollow
 * outline.
 */
function slotToken(filled) {
  const x = 44;
  const y = 44;
  const w = 40;
  const r = 13;
  if (filled) return `<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${r}" fill="${PALETTE.slate}" />`;
  return `<rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${w - 4}" rx="${r - 2}" ${stroke(PALETTE.hair, 6)} fill-opacity="0.35" />`;
}

/** A thin capsule gauge: three cells tile into one continuous rounded track. */
function barSegment(position, filled) {
  const y = 58;
  const h = 12;
  const r = 6;
  const color = filled ? PALETTE.slate : PALETTE.hair;
  const op = filled ? 1 : 0.3;
  if (position === "l") {
    return `<path d="M ${r + 2} ${y} H 128 V ${y + h} H ${r + 2} A ${r} ${r} 0 0 1 2 ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${r + 2} ${y} Z" fill="${color}" fill-opacity="${op}" />`;
  }
  if (position === "r") {
    return `<path d="M 0 ${y} H ${126 - r} A ${r} ${r} 0 0 1 126 ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${126 - r} ${y + h} H 0 Z" fill="${color}" fill-opacity="${op}" />`;
  }
  return `<rect x="0" y="${y}" width="128" height="${h}" fill="${color}" fill-opacity="${op}" />`;
}

function flask() {
  const s = stroke(PALETTE.slate, 8);
  return (
    `<line x1="52" y1="30" x2="76" y2="30" ${s} />` +
    `<path d="M58 32 V56 L36 92 Q32 100 40 100 H88 Q96 100 92 92 L70 56 V32" ${s} />` +
    `<line x1="48" y1="80" x2="80" y2="80" ${stroke(PALETTE.slate, 7)} />`
  );
}

function board() {
  return (
    `<rect x="30" y="66" width="20" height="30" rx="5" fill="${PALETTE.slate}" fill-opacity="0.7" />` +
    `<rect x="54" y="42" width="20" height="54" rx="5" fill="${PALETTE.slate}" />` +
    `<rect x="78" y="56" width="20" height="40" rx="5" fill="${PALETTE.slate}" fill-opacity="0.85" />`
  );
}

function notes() {
  const s = stroke(PALETTE.slate, 7);
  return (
    `<path d="M40 28 H72 L92 48 V96 Q92 100 88 100 H44 Q40 100 40 96 V32 Q40 28 44 28 Z" ${s} />` +
    `<path d="M72 28 V48 H92" ${s} />` +
    `<line x1="52" y1="66" x2="80" y2="66" ${stroke(PALETTE.slate, 6)} />` +
    `<line x1="52" y1="80" x2="80" y2="80" ${stroke(PALETTE.slate, 6)} />`
  );
}

function chainLink() {
  const s = stroke(PALETTE.slate, 8);
  return (
    `<rect x="24" y="50" width="52" height="28" rx="14" transform="rotate(-32 50 64)" ${s} />` +
    `<rect x="52" y="50" width="52" height="28" rx="14" transform="rotate(-32 78 64)" ${s} />`
  );
}

function portalArrow() {
  const s = stroke(PALETTE.slate, 8);
  return (
    `<path d="M62 40 H44 Q38 40 38 46 V90 Q38 96 44 96 H86 Q92 96 92 90 V72" ${s} />` +
    `<line x1="66" y1="62" x2="94" y2="34" ${s} />` +
    `<polyline points="76,32 96,32 96,52" ${s} />`
  );
}

function aperture() {
  const s = stroke(PALETTE.slate, 7);
  let blades = `<circle cx="64" cy="64" r="30" ${s} />`;
  for (let i = 0; i < 3; i += 1) {
    const a = (Math.PI / 3) * (i * 2) - Math.PI / 2;
    const a2 = a + (2 * Math.PI) / 3;
    const x1 = 64 + 30 * Math.cos(a);
    const y1 = 64 + 30 * Math.sin(a);
    const x2 = 64 + 30 * Math.cos(a2);
    const y2 = 64 + 30 * Math.sin(a2);
    blades += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ${stroke(PALETTE.slate, 6)} />`;
  }
  return blades;
}

function gitBranch() {
  const s = stroke(PALETTE.slate, 8);
  return (
    `<line x1="44" y1="47" x2="44" y2="81" ${s} />` +
    `<path d="M44 62 Q70 62 76 54" ${s} />` +
    `<circle cx="44" cy="38" r="9" ${s} />` +
    `<circle cx="44" cy="90" r="9" ${s} />` +
    `<circle cx="86" cy="52" r="9" ${s} />`
  );
}

/**
 * Spinner frames. theta(t) = 360t + A*sin(2*pi*t) keeps the loop seamless in
 * position and velocity while the comet accelerates and strings out, the
 * Windows-ring feel. Neutral throughout: a single calm slate, the lead dot
 * only slightly brighter than its trail. No accent color.
 */
function spinnerFrame(t) {
  const lead = -90 + 360 * t + 28 * Math.sin(2 * Math.PI * t);
  const offsets = [0, -26, -54, -86, -122];
  const radii = [9.5, 8, 6.5, 5, 3.5];
  const shades = ["#9aa2b4", "#818aa0", "#6f7891", "#616a82", "#565e75"];
  const ring = 29;
  let dots = "";
  // Trail first, lead last, so the brightest dot always paints on top.
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    const angle = ((lead + offsets[index]) * Math.PI) / 180;
    const x = 64 + ring * Math.cos(angle);
    const y = 64 + ring * Math.sin(angle);
    dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radii[index]}" fill="${shades[index]}" />`;
  }
  return esvg(dots);
}

function renderPng(source) {
  return new Resvg(source, { fitTo: { mode: "width", value: SIZE } }).render().asPng();
}

function renderRgba(source) {
  const rendered = new Resvg(source, { fitTo: { mode: "width", value: SIZE } }).render();
  return { pixels: new Uint8ClampedArray(rendered.pixels), width: rendered.width, height: rendered.height };
}

function renderSpinnerGif(frameCount = 24, delayMs = 50) {
  const encoder = GIFEncoder();
  for (let frame = 0; frame < frameCount; frame += 1) {
    const { pixels, width, height } = renderRgba(spinnerFrame(frame / frameCount));
    // 1-bit alpha: anything under the threshold becomes fully transparent.
    for (let index = 3; index < pixels.length; index += 4) {
      pixels[index] = pixels[index] < 128 ? 0 : 255;
    }
    const palette = quantize(pixels, 256, { format: "rgba4444", oneBitAlpha: true });
    const indexed = applyPalette(pixels, palette, "rgba4444");
    const transparentIndex = palette.findIndex((entry) => entry[3] === 0);
    encoder.writeFrame(indexed, width, height, {
      palette,
      delay: delayMs,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      dispose: 2,
    });
  }
  encoder.finish();
  return Buffer.from(encoder.bytes());
}

await mkdir(OUT_DIR, { recursive: true });
const written = [];
for (const [name, source] of Object.entries(STATIC)) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await writeFile(file, renderPng(source));
  written.push(path.basename(file));
}
const spinner = renderSpinnerGif();
await writeFile(path.join(OUT_DIR, "cog_spin.gif"), spinner);
written.push(`cog_spin.gif (${(spinner.length / 1024).toFixed(1)} KiB, 24 frames)`);

console.log(`Rendered ${written.length} assets into ${path.relative(process.cwd(), OUT_DIR)}:`);
for (const file of written) console.log(`  ${file}`);
