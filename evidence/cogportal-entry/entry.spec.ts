import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  heroCta,
  openLanding,
  openLinkedPage,
  writeResults,
} from "./helpers";

/**
 * The public entry, exercised in a real browser against the real local dev
 * server (vite + cloudflare worker + local D1, fixture execution provider).
 * The local deployment's session is anonymous with GitHub sign-in
 * unconfigured, so the CTA exercises the honest "Sign in" fallback; the
 * template repo is set in .dev.vars, so the fork link renders.
 */

const LADDER = [
  "Signing in is the first of four steps",
  "join the cohort",
  "join or start your team",
  "set up your machine",
];

test("the entry renders and points at sign-in", async ({ page }, testInfo) => {
  await openLanding(page);

  await expect(page).toHaveTitle(/Cog/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "See how your capstone holds up as the problem gets harder.",
  );

  // The CTA points at sign-in. Its label is whatever the session read
  // honors — locally GitHub is unconfigured, so this is the fallback
  // "Sign in" doing its job. Record the rendered label either way.
  const cta = heroCta(page);
  const label = (await cta.textContent())?.trim() ?? "";
  expect(label).toMatch(/^Sign in( with GitHub)?$/);
  writeResults(`cta-label-${testInfo.project.name}.json`, {
    project: testInfo.project.name,
    renderedLabel: label,
    note: "Local dev has no GitHub App configured (githubConfigured:false), so the fallback label is the honest state; with the App configured the label is 'Sign in with GitHub'.",
  });

  // The quiet CTA and the fork link, both real. The quiet CTA is matched
  // by name: the banner carries two other /leaderboard links.
  await expect(
    page.getByRole("link", { name: "See this year's results" }),
  ).toHaveText("See this year's results");
  await expect(page.locator('a[href^="https://github.com/"]')).toHaveAttribute(
    "href",
    "https://github.com/cogworks-fixtures/capstone-template",
  );

  // No gated link, and the ladder sentence names what follows sign-in.
  // Fragments are asserted within the wayfinding paragraph itself: "set up
  // your machine" also appears verbatim as the Step 2 heading further down
  // the page, and an unscoped match would be ambiguous.
  expect(await page.locator('a[href="/setup"]').count()).toBe(0);
  const wayfinding = page.locator("p", {
    hasText: LADDER[0],
  });
  for (const fragment of LADDER) {
    await expect(wayfinding.getByText(fragment, { exact: false })).toBeVisible();
  }

  await page.screenshot({
    path: `evidence/cogportal-entry/results/landing-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("nothing overflows the viewport", async ({ page }, testInfo) => {
  await openLanding(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(
    overflow,
    `the entry scrolls horizontally by ${overflow}px at ${testInfo.project.name}`,
  ).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: `evidence/cogportal-entry/results/viewport-${testInfo.project.name}.png`,
  });
});

test("keyboard navigation reaches sign-in", async ({ page }, testInfo) => {
  await openLanding(page);

  // Walk the tab order until the HERO CTA is focused (the banner's own
  // sign-in link comes first; the hero must be reachable too); bounded so
  // a broken focus order fails the test instead of hanging it.
  let focused = "";
  for (let step = 0; step < 15; step += 1) {
    await page.keyboard.press("Tab");
    focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (el instanceof HTMLAnchorElement && el.closest("#main")) {
        return el.getAttribute("href") ?? "";
      }
      return "";
    });
    if (focused === "/signin") break;
  }
  expect(focused, "the primary CTA must be reachable by Tab").toBe("/signin");
  await page.screenshot({
    path: `evidence/cogportal-entry/results/keyboard-focus-${testInfo.project.name}.png`,
  });

  await page.keyboard.press("Enter");
  await page.waitForURL("**/signin");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await page.screenshot({
    path: `evidence/cogportal-entry/results/keyboard-signin-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test("reduced motion disables the rise animation", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await openLanding(page);
    const animation = await page.evaluate(() => {
      const el = document.querySelector(".anim-rise");
      if (!el) return { found: false, name: "", duration: "" };
      const style = getComputedStyle(el);
      return {
        found: true,
        name: style.animationName,
        duration: style.animationDuration,
      };
    });
    expect(
      animation.found,
      "the landing column carries the anim-rise hook",
    ).toBe(true);
    expect(
      animation.name,
      "prefers-reduced-motion must turn the rise animation off",
    ).toBe("none");
    await page.screenshot({
      path: `evidence/cogportal-entry/results/reduced-motion-${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("axe: no serious or critical violations on the entry and its two links", async ({
  page,
}, testInfo) => {
  const report: Record<string, unknown> = {};
  for (const [name, open] of [
    ["landing", openLanding],
    ["signin", (p: typeof page) => openLinkedPage(p, "/signin")],
    ["leaderboard", (p: typeof page) => openLinkedPage(p, "/leaderboard")],
  ] as const) {
    await open(page);
    // Let lazy rendering and the session read settle before scanning.
    await page.waitForLoadState("load");
    await page.waitForTimeout(500);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = scan.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    report[`${name}-${testInfo.project.name}`] = {
      url: scan.url,
      violations: scan.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target.join(" ")),
        help: v.help,
      })),
      passes: scan.passes.length,
      incomplete: scan.incomplete.length,
    };
    expect(
      blocking,
      `${name} (${testInfo.project.name}): ${blocking
        .map((v) => `${v.id} on ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
        .join("; ")}`,
    ).toEqual([]);
  }
  writeResults(`axe-${testInfo.project.name}.json`, report);
});
