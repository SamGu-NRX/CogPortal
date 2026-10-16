import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";

/** Results live next to the suite regardless of the runner's cwd. */
export const RESULTS_DIR = fileURLToPath(new URL("./results/", import.meta.url));

export function resultsPath(name: string): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  return RESULTS_DIR + name;
}

export function writeResults(name: string, data: unknown): string {
  const path = resultsPath(name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

/** Wait past the session read: the CTA settles on the label the deployment
 *  can honor before anything is asserted. The hero CTA is scoped to #main —
 *  the banner carries its own "Sign in" link. */
export function heroCta(page: Page) {
  return page
    .locator("#main")
    .getByRole("link", { name: /^Sign in( with GitHub)?$/ });
}

export async function openLanding(page: Page): Promise<void> {
  await page.goto("/");
  await heroCta(page).waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
}

/** The same wait for the two pages the entry links to. */
export async function openLinkedPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator("main, body").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
}

/** Buffer layout-shift entries (with sources) into the page before it runs.
 *  We drop entries with hadRecentInput to match the CLS definition. Nothing
 *  here suppresses motion or font loading — the page loads exactly as it
 *  would for a student. */
export const SHIFT_OBSERVER_SCRIPT = `
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      window.__shifts.push({
        value: entry.value,
        time: entry.startTime,
        sources: (entry.sources ?? []).map((s) => {
          // Plain browser JS — this string is injected via addInitScript and
          // never transpiled, so no TypeScript may appear here. SVG nodes
          // (the hero's GitHub icon) have no className string property.
          const chain = [];
          let el = s.node?.parentElement ?? null;
          for (let depth = 0; el && depth < 4; depth += 1) {
            chain.push(
              el.tagName +
                "." +
                (el.getAttribute ? el.getAttribute("class") || "" : "") +
                " :: " +
                (el.textContent ?? "").trim().slice(0, 60),
            );
            el = el.parentElement;
          }
          return {
            node: s.node
              ? s.node.nodeName + "." + (s.node.getAttribute ? s.node.getAttribute("class") || "" : "")
              : "unknown",
            ancestors: chain,
            previousRect: s.previousRect,
            currentRect: s.currentRect,
          };
        }),
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
`;

export function screenshotName(testInfo: TestInfo, name: string): string {
  return `${name}-${testInfo.project.name}.png`;
}
