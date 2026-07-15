/**
 * TASTE PREVIEW ONLY — renders sample "bench report" stamps so we can judge
 * whether a terminal-state image card earns a place in the Discord message.
 * Not wired to production: the free Workers plan cannot rasterize on-worker.
 * See docs/design/discord-bench-report-stamp.md for the spec + upgrade path.
 *
 * Font note: this preview falls back to system serif/mono (Georgia/Menlo).
 * Production would ship real Source Serif 4 + IBM Plex Mono TTFs to the
 * renderer; judge composition and hierarchy here, not letterforms.
 *
 * Usage: node scripts/render-bench-stamp.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "emoji", "dist");
const S = 480; // rendered at 2x; displays at 240 in a Section thumbnail

const TOKENS = {
  paper: "#f7f3ea",
  paperSunken: "#efe9db",
  ink: "#1c2637",
  inkSecondary: "#4b566b",
  inkFaint: "#7d8697",
  rule: "rgba(28,38,55,0.16)",
  detect: "#c63d2f",
  verify: "#2e6b4f",
};

const SERIF = `'Source Serif 4', Georgia, serif`;
const MONO = `'IBM Plex Mono', Menlo, monospace`;

function brackets(x1, y1, x2, y2, arm, color, width) {
  const s = `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="square"`;
  return (
    `<polyline points="${x1},${y1 + arm} ${x1},${y1} ${x1 + arm},${y1}" ${s} />` +
    `<polyline points="${x2 - arm},${y1} ${x2},${y1} ${x2},${y1 + arm}" ${s} />` +
    `<polyline points="${x2},${y2 - arm} ${x2},${y2} ${x2 - arm},${y2}" ${s} />` +
    `<polyline points="${x1 + arm},${y2} ${x1},${y2} ${x1},${y2 - arm}" ${s} />`
  );
}

function stamp({ eyebrow, eyebrowColor, score, metricLabel, benchmark, sha, duration, simulated }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${TOKENS.paper}" />
  <rect x="1" y="1" width="${S - 2}" height="${S - 2}" fill="none" stroke="${TOKENS.rule}" stroke-width="2" />
  ${brackets(28, 28, S - 28, S - 28, 26, TOKENS.detect, 5)}
  <text x="${S / 2}" y="104" text-anchor="middle" font-family="${MONO}" font-size="22" letter-spacing="6" fill="${eyebrowColor}">${eyebrow}</text>
  <text x="${S / 2}" y="252" text-anchor="middle" font-family="${SERIF}" font-size="118" font-weight="600" fill="${TOKENS.ink}">${score}</text>
  <text x="${S / 2}" y="296" text-anchor="middle" font-family="${MONO}" font-size="20" fill="${TOKENS.inkFaint}">${metricLabel}</text>
  <line x1="96" y1="336" x2="${S - 96}" y2="336" stroke="${TOKENS.rule}" stroke-width="2" />
  <text x="${S / 2}" y="376" text-anchor="middle" font-family="${SERIF}" font-size="28" font-style="italic" fill="${TOKENS.inkSecondary}">${benchmark}</text>
  <text x="${S / 2}" y="414" text-anchor="middle" font-family="${MONO}" font-size="19" fill="${TOKENS.inkFaint}">${sha}  ${duration}${simulated ? "  simulated" : ""}</text>
</svg>`;
}

const samples = [
  {
    name: "stamp-bench-clear",
    eyebrow: "BENCH CLEAR",
    eyebrowColor: TOKENS.verify,
    score: "0.913",
    metricLabel: "accuracy, higher is better",
    benchmark: "Face Recognition",
    sha: "89353d0",
    duration: "0:49",
    simulated: true,
  },
  {
    name: "stamp-published",
    eyebrow: "PUBLISHED",
    eyebrowColor: TOKENS.detect,
    score: "0.884",
    metricLabel: "accuracy, official attempt 2 of 3",
    benchmark: "Face Recognition",
    sha: "89353d0",
    duration: "0:21",
    simulated: false,
  },
];

await mkdir(OUT, { recursive: true });
for (const sample of samples) {
  const png = new Resvg(stamp(sample), { fitTo: { mode: "width", value: S } }).render().asPng();
  await writeFile(path.join(OUT, `${sample.name}.png`), png);
  console.log(`rendered emoji/dist/${sample.name}.png`);
}
