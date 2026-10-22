// M4 measurements, shared by the journeys that check a page.
//
// - axe, once the page's content has loaded (no loading mark, no busy
//   region), with every violation reported.
// - Text contrast by computed colour where axe can't decide. axe reports
//   text over a gradient, an image or a translucent layer as "incomplete"
//   rather than pass or fail. For each such node this module photographs the
//   node's box inside its border with every glyph and icon on the page made
//   transparent (underlines too) and the node's own ::before/::after decorations (a link's
//   underline bar) hidden, reads the pixels
//   behind the text in the browser (canvas), and computes the contrast of
//   the text's computed colour against each pixel. The node's ratio is the
//   5th percentile over its pixels: the worst part of a gradient counts, a
//   1px dot of the page's dot grid (about 1% of any box) does not. 4.5:1 is
//   the bar for normal text, 3:1 for large text (24px, or 18.66px bold).
// - No horizontal overflow at the page's width.
// - Reduced motion: with `prefers-reduced-motion: reduce`, nothing on the
//   page animates at all, from its first script through hovering, focusing
//   and opening its controls (recordMotion, exercise, expectNoMotion).

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
  // Finite animations (entrances) only: a live indicator loops forever.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      ),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]),
  );
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
async function measureIncomplete(page, nodes, frame = null) {
  const results = [];
  for (const node of nodes) {
    const selector = node.target.at(-1);
    if (typeof selector !== "string") continue;
    // A node inside the Activity's frame has the frame's selector first.
    const root = node.target.length > 1 && frame ? frame : page;
    const element = root.locator(selector).first();
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
      // Every glyph on the page goes transparent, not only this node's: a
      // wrapped inline node's box spans its neighbours' text, and a node's
      // children may set their own colour. Icons go too. Backgrounds,
      // gradients and images stay.
      const sheet = document.createElement("style");
      sheet.id = "rj-measure-style";
      sheet.textContent =
        "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important}" +
        "svg{visibility:hidden!important}" +
        "[data-rj-measure]::before,[data-rj-measure]::after{visibility:hidden!important}";
      document.head.append(sheet);
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
      document.getElementById("rj-measure-style")?.remove();
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
export async function expectAccessible(page, label, { frame = null } = {}) {
  await settle(page);
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`),
    `axe violations on ${label}`,
  ).toEqual([]);
  const incompleteContrast = result.incomplete.find((rule) => rule.id === "color-contrast")?.nodes ?? [];
  const measured = await measureIncomplete(page, incompleteContrast, frame);
  // Every incomplete node was measured or isn't visible; none skipped for want of a root.
  expect(incompleteContrast.filter((n) => n.target.length > 1 && !frame), `contrast nodes in a frame on ${label}`).toEqual([]);
  expect(
    measured.filter((m) => m.ratio < m.required),
    `text below its contrast bar on ${label}, measured on pixels`,
  ).toEqual([]);
  const overflow = await (frame ?? page).evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label} is wider than the window`).toBeLessThanOrEqual(0);
  return { measured: measured.length };
}

/**
 * Records every animation that starts in a context's pages and frames, from
 * before their first script: CSS animations and transitions (by their start
 * events, so a finite entrance is caught even after it ends), Web Animations
 * made by script (Element.animate, which Motion uses), and inline styles a
 * script rewrites frame after frame (a JavaScript-driven tween). Read with
 * `motionSeen`. Under reduced motion nothing may appear here: an animation of
 * 1ms or less counts as none, since it changes nothing a person can see.
 */
export async function recordMotion(context) {
  await context.addInitScript(() => {
    const seen = [];
    window.__rjMotion = seen;
    const name = (el) => {
      if (!el || !el.tagName) return "?";
      const cls = String(el.className?.baseVal ?? el.className ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 4).join(".");
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}`;
    };
    // An animation that already ended (or a transition already cancelled)
    // is gone from getAnimations by the time its event arrives; its length is
    // then read from the element's computed style.
    const seconds = (list) => Math.max(0, ...String(list).split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 0.001 : 1) || 0));
    const styled = (target, kind) => {
      const style = getComputedStyle(target);
      if (kind !== "css-animation") return (seconds(style.transitionDuration) + seconds(style.transitionDelay)) * 1000;
      const each = seconds(style.animationDuration);
      const count = /infinite/.test(style.animationIterationCount) ? Infinity : parseFloat(style.animationIterationCount) || 1;
      return each === 0 ? 0 : (each * count + seconds(style.animationDelay)) * 1000;
    };
    const note = (kind, target, what, animation) => {
      const timing = animation?.effect?.getComputedTiming?.();
      const duration = timing ? timing.activeDuration : kind === "web-animation" ? undefined : styled(target, kind);
      if (duration !== undefined && duration <= 1) return;
      seen.push({ kind, target: name(target), what, durationMs: duration === undefined ? "unknown" : Number.isFinite(duration) ? Math.round(duration) : "infinite" });
    };
    const find = (target, test) => (target.getAnimations ? target.getAnimations().find(test) : undefined);
    document.addEventListener("animationstart", (e) => note("css-animation", e.target, e.animationName, find(e.target, (a) => a.animationName === e.animationName)), true);
    document.addEventListener("transitionrun", (e) => note("css-transition", e.target, e.propertyName, find(e.target, (a) => a.transitionProperty === e.propertyName)), true);
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      note("web-animation", this, "Element.animate", animation);
      return animation;
    };
    // A script tween rewrites an element's inline style on consecutive
    // frames; a progress bar or a popover's position changes now and then.
    let frame = 0;
    const tick = () => {
      frame += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const frames = new WeakMap();
    new MutationObserver((records) => {
      for (const record of records) {
        const list = frames.get(record.target) ?? [];
        if (list.at(-1) !== frame) list.push(frame);
        while (list.length > 4) list.shift();
        frames.set(record.target, list);
        if (list.length === 4 && list[3] - list[0] <= 6 && !list.flagged) {
          list.flagged = true;
          seen.push({ kind: "script-style-tween", target: name(record.target), what: "inline style rewritten on 4 frames in a row", durationMs: "unknown" });
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
}

/** What recordMotion saw in `target` (a page or a frame). */
export function motionSeen(target) {
  return target.evaluate(() => window.__rjMotion ?? null);
}

/**
 * Works a page's controls the way a person does without changing anything:
 * hovers and focuses each one, then opens and closes each disclosure and
 * menu (aria-expanded buttons and <summary>), so a transition that only runs
 * on interaction gets its chance to run.
 */
export async function exercise(page, root = page) {
  const controls = root.locator("a[href], button, input, select, textarea, summary, [role='tab'], [tabindex='0']");
  const count = Math.min(await controls.count(), 60);
  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.hover({ timeout: 2_000 }).catch(() => {});
    await control.focus({ timeout: 2_000 }).catch(() => {});
  }
  // Tagged first: opening one changes which others match the selector.
  const tagged = await root.locator("button[aria-expanded='false'], summary").evaluateAll((elements) => {
    elements.slice(0, 12).forEach((element, i) => element.setAttribute("data-rj-toggle", String(i)));
    return Math.min(elements.length, 12);
  });
  for (let i = 0; i < tagged; i += 1) {
    const toggle = root.locator(`[data-rj-toggle="${i}"]`);
    if (!(await toggle.isVisible().catch(() => false))) continue;
    await toggle.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  }
  await page.mouse.move(0, 0);
}

/**
 * Under reduced motion nothing animated, from the page's first script
 * through `exercise`: `targets` are the page and any frames to read.
 */
export async function expectNoMotion(targets, label) {
  const seen = [];
  for (const target of targets) {
    const motion = await motionSeen(target);
    if (motion === null) throw new Error(`${label}: motion was not being recorded (recordMotion before the page opened)`);
    seen.push(...motion);
  }
  expect(seen, `animations under reduced motion on ${label}`).toEqual([]);
}

/** The element that has focus, described for assertions. */
export function focused(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 80), label: el.getAttribute("aria-label") };
  });
}
