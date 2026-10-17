/**
 * Walks the built portal through the five connect/setup paths against the
 * fixture server, capturing observed state sequences and screenshots. No real
 * GitHub/Modal calls: the SPA talks only to the local fixture server.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:4173";
// Outputs land beside this script, not an author-specific path.
const OUT = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const report = { startedAt: new Date().toISOString(), paths: [] };

async function setScenario(page, scenario, extra = {}) {
  const resp = await page.request.post(`${BASE}/__fixture`, { data: { scenario, ...extra } });
  if (!resp.ok()) throw new Error(`fixture set failed: ${resp.status()}`);
}

async function observe(page, label, shot) {
  const o = await page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    const count = text("[aria-live=polite]");
    const headings = [...document.querySelectorAll("main h1, main h2")].slice(0, 8).map((h) => h.textContent.trim());
    const steps = [...document.querySelectorAll("[data-step-state], [class*=step]")].length;
    const focused = document.activeElement ? `${document.activeElement.tagName}:${(document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent ?? "").slice(0, 40)}` : null;
    const alerts = [...document.querySelectorAll("[role=alert], [role=status]")].map((a) => a.textContent.trim()).filter(Boolean).slice(0, 6);
    return { url: location.pathname + location.search, h1: text("main h1") ?? text("h1"), count, headings, steps, focused, alerts };
  });
  if (shot) await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: false });
  o.label = label;
  report.paths.at(-1).states.push(o);
  return o;
}

async function newPath(page, name) {
  report.paths.push({ name, states: [], consoleErrors: [] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

/* Listeners registered once for the whole walk; entries credit whichever path
 * is current when the event fires. Re-registering per path would stack one
 * listener per path and multiply every later response event. */
page.on("response", (r) => {
  if (r.status() >= 400) report.paths.at(-1)?.consoleErrors.push(`[http ${r.status()}] ${r.request().method()} ${r.url()}`);
});
page.on("pageerror", (err) => report.paths.at(-1)?.consoleErrors.push(`pageerror: ${err.message.slice(0, 300)}`));

/* ── 1. First run: sign-in → /connect wizard → /setup → device + evidence ── */
{
  await newPath(page, "first-run");
  await setScenario(page, "first-run");
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
  await observe(page, "connect choice screen", "first-run-1-choice");

  // Back behavior on the join step (no teams in fixture: choice screen is skipped).
  await page.goto(`${BASE}/connect?path=start`, { waitUntil: "networkidle" });
  await observe(page, "start step direct", "first-run-2-start");
  const backVisible = await page.getByRole("button", { name: "Back" }).isVisible().catch(() => false);
  report.paths.at(-1).backOnDirectEntry = backVisible;

  // Full create flow from the choice screen: this fixture has no cohort teams,
  // so the page should land straight on the start form.
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
  const picker = await page.waitForSelector("form", { timeout: 8000 }).catch(() => null);
  report.paths.at(-1).startFormShownWithoutChoice = Boolean(picker);
  await page.getByText("cogworks-demo/face-finder", { exact: false }).first().click().catch(() => {});
  await sleep(400);
  await observe(page, "repo chosen, team name step appears", "first-run-3-teamname");
  await page.getByRole("button", { name: /Create|Join/ }).click().catch((e) => report.paths.at(-1).consoleErrors.push(`create-click: ${e.message.slice(0, 120)}`));
  await sleep(900);
  await observe(page, "after create", "first-run-4-after-create");

  // Wherever the create left us: the journey should be ON /setup with an arrival note.
  await observe(page, "setup arrival state", "first-run-5-setup-arrival");

  // Walk to the device approval through the real seam: the approval page.
  await page.goto(`${BASE}/connections?user_code=ABCD-1234-EFGH&return_to=setup`, { waitUntil: "networkidle" });
  await observe(page, "device approval page", "first-run-6-approval");
  await page.getByRole("button", { name: "Approve device" }).click();
  // approval + auto-return to /setup (a 900ms timer): wait for the landing, not a clock
  await page.waitForURL(/\/setup/, { timeout: 15000 }).catch(() => {});
  await observe(page, "back from approval", "first-run-7-back-from-approval");
  // the connections poll (~2.5s) and the setup-state poll must both land: wait
  // for the rail to tick 1 of 5 instead of sleeping through both
  await page.locator("text=/1 of 5/").first().waitFor({ timeout: 15000 }).catch(() => {});
  const linked = await observe(page, "setup after approval poll", "first-run-8-setup-after-poll");
  report.paths.at(-1).linkTickedAfterApproval = linked.count?.startsWith("1 of 5") ?? false;
}

/* ── 1b. Choice screen with cohort teams: Join step and its Back control ──── */
{
  await newPath(page, "first-run-with-teams");
  await setScenario(page, "first-run-with-teams");
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
  await sleep(400);
  await observe(page, "choice screen with a team present", "choice-1-screen");
  await page.getByText("Join a team someone already started").first().click();
  await page.getByText("Search Squad").first().click({ timeout: 5000 }).catch((e) => report.paths.at(-1).consoleErrors.push(`choice-click: ${e.message.slice(0, 120)}`));
  await sleep(400);
  await observe(page, "join step from choice", "choice-2-join");
  const backVisible = await page.getByRole("button", { name: /Back/ }).isVisible().catch(() => false);
  report.paths.at(-1).backOnJoinStep = backVisible;
  if (backVisible) {
    await page.getByRole("button", { name: /Back/ }).click();
    await sleep(400);
    const back = await observe(page, "back to choice", "choice-3-back");
    report.paths.at(-1).backReturnsToChoice = back.url.startsWith("/connect") && back.headings.length > 0;
  }
  // Direct entry to the join step must still offer a way back.
  await page.goto(`${BASE}/connect?path=join`, { waitUntil: "networkidle" });
  await sleep(400);
  await observe(page, "join step direct entry", "choice-4-direct-join");
  report.paths.at(-1).backOnDirectJoinEntry = await page.getByRole("button", { name: /Back/ }).isVisible().catch(() => false);
}

/* ── 2. Expired code: approval refused, recovery offered ──────────────────── */
{
  await newPath(page, "expired-code");
  await setScenario(page, "expired-code");
  await page.goto(`${BASE}/connections?user_code=ABCD-1234-EFGH`, { waitUntil: "networkidle" });
  await observe(page, "expired code approval form", "expired-1-form");
  await page.getByRole("button", { name: "Approve device" }).click();
  await sleep(700);
  const refused = await observe(page, "after refused approval", "expired-2-refused");
  report.paths.at(-1).refusalMessage = refused.alerts;
  report.paths.at(-1).recoveryShown = refused.alerts.some((a) => a.toLowerCase().includes("invalid") || a.includes("fresh"));
  const content = await page.content();
  const visible = await page.locator("main").innerText();
  report.paths.at(-1).freshCommandShown = visible.includes("cogworks link --portal");
  await observe(page, "recovery panel with fresh command", "expired-3-recovery");
}

/* ── 3. Changed team: join the second team through the UI, commands follow ── */
{
  await newPath(page, "changed-team");
  await setScenario(page, "changed-team");
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
  await sleep(400);
  await observe(page, "choice screen with cohort teams", "changed-1-choice");
  await page.getByText("Join a team someone already started").first().click();
  await page.getByText("Search Squad").first().click({ timeout: 5000 }).catch((e) => report.paths.at(-1).consoleErrors.push(`choice-click: ${e.message.slice(0, 120)}`));
  await sleep(400);
  await observe(page, "join step", "changed-2-join");
  const backVisible = await page.getByRole("button", { name: /Back/ }).isVisible().catch(() => false);
  report.paths.at(-1).backOnJoinStep = backVisible;
  await page.getByRole("button", { name: /Join/ }).click().catch((e) => report.paths.at(-1).consoleErrors.push(`join-click: ${e.message.slice(0, 120)}`));
  await sleep(1100);
  const joined = await observe(page, "after join", "changed-3-after-join");
  report.paths.at(-1).commandsNameNewRepo = joined.url === "/setup" && (await page.content()).includes("cogworks-demo/search-engine");
  report.paths.at(-1).arrivalNote = joined.alerts;
}

/* ── 4. Unavailable template: start-a-team without the course template ────── */
{
  await newPath(page, "unavailable-template");
  await setScenario(page, "unavailable-template");
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle" });
  await observe(page, "connect with no template, no repos", "untemplate-1-connect");
  const content = await page.content();
  report.paths.at(-1).noTemplateHint = content.includes("Pick the public repository your team will work in") || content.includes("Pick a public repository");
  report.paths.at(-1).forkStepsShown = content.includes("Check again");
  await observe(page, "fork steps without template", "untemplate-2-forksteps");
}

/* ── 5. Existing run: setup complete, revisited ───────────────────────────── */
{
  await newPath(page, "existing-run");
  await setScenario(page, "existing-run");
  await page.goto(`${BASE}/setup`, { waitUntil: "networkidle" });
  await sleep(800);
  const done = await observe(page, "setup complete revisited", "existing-1-complete");
  report.paths.at(-1).countFiveOfFive = done.count?.startsWith("5 of 5") ?? false;
  report.paths.at(-1).completionClaim = done.alerts.find((a) => a.includes("checks out") || a.includes("ready")) ?? null;
  const content = await page.content();
  report.paths.at(-1).distinguishesCheckedFromVerified = content.includes("checked off by you") || content.includes("seen by the portal");
}

await browser.close();
writeFileSync(fileURLToPath(new URL("./walk-report.json", import.meta.url)), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.paths.map((p) => ({ name: p.name, states: p.states.length, consoleErrors: p.consoleErrors })), null, 2));
