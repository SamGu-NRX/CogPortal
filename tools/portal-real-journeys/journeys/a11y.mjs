// M4 measurements, shared by the journeys that check a page.
//
// - axe, once the page's content has loaded (no loading mark, no busy
//   region), with every violation reported.
// - Text contrast by computed colour where axe can't decide. axe reports
//   text over a gradient, an image or a translucent layer as "incomplete"
//   rather than pass or fail. For each such node this module photographs the
//   node's box inside its border, with its own text, text shadow and
//   ::before/::after decorations (a link's underline bar) made invisible,
//   reads the pixels
//   behind the text in the browser (canvas), and computes the contrast of
//   the text's computed colour against each pixel. The node's ratio is the
//   5th percentile over its pixels: the worst part of a gradient counts, a
//   1px dot of the page's dot grid (about 1% of any box) does not. 4.5:1 is
//   the bar for normal text, 3:1 for large text (24px, or 18.66px bold).
// - No horizontal overflow at the page's width.
// - Reduced motion: with `prefers-reduced-motion: reduce`, nothing on the
//   page is still animating once it has settled.

import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

/** Waits until the page shows content: no loading mark or busy region, fonts in. */
export async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator('[aria-busy="true"]:not(.run-console)')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Worst contrast of each text node axe left incomplete, measured on pixels.
 * Returns [{ target, ratio, required }].
 */
async function measureIncomplete(page, nodes) {
  const results = [];
  for (const node of nodes) {
    const selector = node.target.at(-1);
    if (typeof selector !== "string") continue;
    const element = page.locator(selector).first();
    if (!(await element.isVisible().catch(() => false))) continue;
    const facts = await element.evaluate((el) => {
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const previous = el.style.getPropertyValue("color");
      const previousShadow = el.style.getPropertyValue("text-shadow");
      el.dataset.rjColour = style.color;
      el.style.setProperty("color", "transparent", "important");
      el.style.setProperty("text-shadow", "none", "important");
      el.dataset.rjRestore = JSON.stringify({ previous, previousShadow });
      el.setAttribute("data-rj-measure", "");
      if (!document.getElementById("rj-measure-style")) {
        const sheet = document.createElement("style");
        sheet.id = "rj-measure-style";
        sheet.textContent = "[data-rj-measure]::before,[data-rj-measure]::after{visibility:hidden!important}";
        document.head.append(sheet);
      }
      const border = ["Top", "Right", "Bottom", "Left"].map((side) => parseFloat(style[`border${side}Width`]) || 0);
      return { colour: el.dataset.rjColour, large: size >= 24 || (bold && size >= 18.66), border };
    });
    await element.scrollIntoViewIfNeeded().catch(() => {});
    const outer = await element.boundingBox();
    // Inside the border: a badge's dashed outline is not what the text sits on.
    const [top, right, bottom, left] = facts.border;
    const box = outer && { x: outer.x + left, y: outer.y + top, width: outer.width - left - right, height: outer.height - top - bottom };
    const view = page.viewportSize();
    // The part of the box inside the viewport; a screenshot can't clip outside it.
    const clip = box && view && {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(view.width, box.x + box.width) - Math.max(0, box.x),
      height: Math.min(view.height, box.y + box.height) - Math.max(0, box.y),
    };
    let shot = null;
    if (clip && clip.width >= 1 && clip.height >= 1) shot = await page.screenshot({ clip, animations: "disabled" });
    await element.evaluate((el) => {
      const { previous, previousShadow } = JSON.parse(el.dataset.rjRestore);
      if (previous) el.style.setProperty("color", previous);
      else el.style.removeProperty("color");
      if (previousShadow) el.style.setProperty("text-shadow", previousShadow);
      else el.style.removeProperty("text-shadow");
      delete el.dataset.rjRestore;
      delete el.dataset.rjColour;
      el.removeAttribute("data-rj-measure");
    });
    if (!shot) continue;
    const pixels = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      // Each distinct colour with how many pixels have it.
      const seen = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        const entry = seen.get(key);
        if (entry) entry[1] += 1;
        else seen.set(key, [[data[i], data[i + 1], data[i + 2]], 1]);
      }
      return [...seen.values()];
    }, shot.toString("base64"));
    const rgb = facts.colour.match(/[\d.]+/g).slice(0, 3).map(Number);
    const ranked = pixels.map(([pixel, count]) => [contrast(rgb, pixel), count]).sort((a, b) => a[0] - b[0]);
    const total = ranked.reduce((sum, [, count]) => sum + count, 0);
    let seenCount = 0;
    let ratio = ranked.at(-1)[0];
    for (const [value, count] of ranked) {
      seenCount += count;
      if (seenCount >= total * 0.05) {
        ratio = value;
        break;
      }
    }
    results.push({ target: selector, ratio: Math.round(ratio * 100) / 100, required: facts.large ? 3 : 4.5 });
  }
  return results;
}

/**
 * axe with zero violations, and computed contrast for what axe left
 * incomplete. `label` names the page in failure messages.
 */
export async function expectAccessible(page, label) {
  await settle(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`),
    `axe violations on ${label}`,
  ).toEqual([]);
  const incompleteContrast = result.incomplete.find((rule) => rule.id === "color-contrast")?.nodes ?? [];
  const measured = await measureIncomplete(page, incompleteContrast);
  expect(
    measured.filter((m) => m.ratio < m.required),
    `text below its contrast bar on ${label}, measured on pixels`,
  ).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label} is wider than the window`).toBeLessThanOrEqual(0);
  return { measured: measured.length };
}

/** Under reduced motion, nothing is still moving once the page settles. */
export async function expectStill(page, label) {
  await settle(page);
  const moving = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => {
        const target = animation.effect?.target;
        const name = animation.animationName ?? animation.transitionProperty ?? animation.constructor.name;
        return `${name} on ${target?.tagName?.toLowerCase() ?? "?"}.${String(target?.className ?? "").slice(0, 60)}`;
      }),
  );
  expect(moving, `animations still running under reduced motion on ${label}`).toEqual([]);
}

/** The element that has focus, described for assertions. */
export function focused(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 80), label: el.getAttribute("aria-label") };
  });
}
