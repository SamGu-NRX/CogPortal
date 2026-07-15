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

/** Mid-tone derivatives of the portal palette; readable on dark and light. */
const PALETTE = {
  detect: "#c63d2f",
  verify: "#3d7c5e",
  steel: "#5a6478",
  faint: "#7d8697",
};

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

const stroke = (color, width) =>
  `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

/** Static marks. One glyph, one meaning. */
const STATIC = {
  cog_done: svg(`<polyline points="36,68 57,88 92,42" ${stroke(PALETTE.verify, 11)} />`),
  cog_fail: svg(
    `<line x1="42" y1="42" x2="86" y2="86" ${stroke(PALETTE.detect, 11)} />` +
      `<line x1="86" y1="42" x2="42" y2="86" ${stroke(PALETTE.detect, 11)} />`,
  ),
  cog_pend: svg(`<circle cx="64" cy="64" r="23" ${stroke(PALETTE.faint, 9)} />`),
  cog_active: svg(cornerBrackets(40, 40, 88, 88, 15, PALETTE.detect, 8) + `<circle cx="64" cy="64" r="9" fill="${PALETTE.steel}" />`),
  cog_star: svg(asterisk(64, 64, 12, 34, PALETTE.verify, 11)),
  cog_slot_used: svg(`<rect x="44" y="30" width="40" height="68" rx="12" fill="${PALETTE.detect}" />`),
  cog_slot_free: svg(`<rect x="44" y="30" width="40" height="68" rx="12" ${stroke(PALETTE.faint, 8)} />`),
  // Bar cells form a capsule when adjacent: rounded outer caps, flush inner edges.
  cog_bar_l_1: svg(barSegment("l", PALETTE.steel, true)),
  cog_bar_l_0: svg(barSegment("l", PALETTE.faint, false)),
  cog_bar_m_1: svg(barSegment("m", PALETTE.steel, true)),
  cog_bar_m_0: svg(barSegment("m", PALETTE.faint, false)),
  cog_bar_r_1: svg(barSegment("r", PALETTE.steel, true)),
  cog_bar_r_0: svg(barSegment("r", PALETTE.faint, false)),
};

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

function barSegment(position, color, filled) {
  const y = 54;
  const height = 20;
  const radius = 10;
  const opacity = filled ? 1 : 0.42;
  if (position === "l") {
    return `<path d="M ${radius + 4} ${y} H 128 V ${y + height} H ${radius + 4} A ${radius} ${radius} 0 0 1 4 ${y + height - radius} V ${y + radius} A ${radius} ${radius} 0 0 1 ${radius + 4} ${y} Z" fill="${color}" fill-opacity="${opacity}" />`;
  }
  if (position === "r") {
    return `<path d="M 0 ${y} H ${124 - radius} A ${radius} ${radius} 0 0 1 124 ${y + radius} V ${y + height - radius} A ${radius} ${radius} 0 0 1 ${124 - radius} ${y + height} H 0 Z" fill="${color}" fill-opacity="${opacity}" />`;
  }
  return `<rect x="0" y="${y}" width="128" height="${height}" fill="${color}" fill-opacity="${opacity}" />`;
}

/**
 * Spinner frames. theta(t) = 360t + A*sin(2*pi*t) keeps the loop seamless in
 * position and velocity while the comet visibly accelerates and strings out,
 * the Windows-ring feel. The lead dot carries detector red; the trail is
 * steel-gray shrinking to nothing.
 */
function spinnerFrame(t) {
  const lead = -90 + 360 * t + 28 * Math.sin(2 * Math.PI * t);
  const offsets = [0, -26, -54, -86, -122];
  const radii = [10, 8, 6.5, 5, 3.5];
  const ring = 29;
  let dots = "";
  // Trail first, lead last, so the red lead dot always paints on top.
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    const angle = ((lead + offsets[index]) * Math.PI) / 180;
    const x = 64 + ring * Math.cos(angle);
    const y = 64 + ring * Math.sin(angle);
    const color = index === 0 ? PALETTE.detect : PALETTE.steel;
    dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radii[index]}" fill="${color}" />`;
  }
  return svg(dots);
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
