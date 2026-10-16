#!/usr/bin/env node
/**
 * Setup-checklist walkthrough: a student runs the five commands from
 * "Set up your machine" in a real shell, and the page watches them tick.
 *
 * The page is the witness: after each command the driver reads the five
 * step rows (#step-clone, #step-tool, #step-benchmark, #step-link,
 * #step-check) and the "N of 5 done" masthead WITHOUT a reload, inside the
 * poll interval, and records what changed and when. Screenshots land in
 * evidence/ at 1440 and 390 px at 0 of 5, midway, and 5 of 5.
 *
 * Environment it assumes (documented in the PR body):
 * - portal dev server on 127.0.0.1:5173 (alpha local stack, fixture GitHub
 *   client, DEV_AUTH=enabled)
 * - git insteadOf rewrites https://github.com/cogworks-demo/face-finder.git
 *   to a local bare repository, so the page's clone command runs without
 *   touching real GitHub while origin still reads the GitHub URL
 * - `python` on PATH is a Python 3.11 environment whose heavy week2
 *   dependencies are already warm, so the page's pip lines resolve quickly
 *
 * usage: DEV_LOGIN=<name> node run.mjs [--out evidence]
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORTAL = process.env.PORTAL ?? "http://127.0.0.1:5173";
const outIdx = process.argv.indexOf("--out");
const OUT = path.resolve(outIdx === -1 ? "evidence" : process.argv[outIdx + 1]);
const LOGIN = process.env.DEV_LOGIN ?? "burst14-student";
const WORKDIR = process.env.SEAT_DIR ?? path.join(process.env.HOME, "work", "burst14-seat");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORKDIR, { recursive: true });

const log = (m) => console.log(`[walk] ${new Date().toISOString()} ${m}`);
const dump = (name, text) => fs.writeFileSync(path.join(OUT, name), text);

const t0 = Date.now();
const since = () => Math.round((Date.now() - t0) / 1000);
const journey = { startedAt: new Date().toISOString(), portal: PORTAL, login: LOGIN, steps: [], screenshots: [] };

// ── the page witness ────────────────────────────────────────────────────────
const STEP_IDS = ["clone", "tool", "benchmark", "link", "check"];

async function readChecklist(p) {
  return p.evaluate((ids) => {
    const count = document.querySelector(".u-tnum")?.textContent ?? null;
    const rows = {};
    for (const id of ids) {
      const row = document.getElementById(`step-${id}`);
      if (!row) { rows[id] = "missing"; continue; }
      const text = row.innerText;
      rows[id] = text.includes("Verified.")
        ? "verified"
        : text.includes("Checked off from your terminal.")
          ? "checked"
          : text.includes("Progress unknown.")
            ? "unknown"
            : "pending";
    }
    const watching = document.body.innerText.includes("Watching for your terminal");
    return { count, rows, watching };
  }, STEP_IDS);
}

/** Watch the page without a reload until the checklist changes (or cap). */
async function watchFor(p, before, capMs) {
  const start = Date.now();
  let last = before;
  while (Date.now() - start < capMs) {
    await p.waitForTimeout(750);
    last = await readChecklist(p);
    if (JSON.stringify(last) !== JSON.stringify(before)) {
      return { changed: true, after: last, seconds: Math.round((Date.now() - start) / 1000) };
    }
  }
  return { changed: false, after: last, seconds: Math.round((Date.now() - start) / 1000) };
}

async function shot(p, name) {
  await p.screenshot({ path: path.join(OUT, name), fullPage: true });
  journey.screenshots.push(name);
  log(`screenshot ${name}`);
}

// ── the shell the student runs commands in ─────────────────────────────────
const shell = spawn("bash", ["--norc", "-i"], { cwd: WORKDIR, env: process.env });
let out = "";
shell.stdout.setEncoding("utf8");
shell.stderr.setEncoding("utf8");
shell.stdout.on("data", (d) => (out += d));
shell.stderr.on("data", (d) => (out += d));

function runCommand(cmdline, timeoutMs) {
  return new Promise((resolve) => {
    const id = Date.now();
    const begin = out.length;
    shell.stdin.write(`${cmdline}\necho "___DONE_${id}_$?___"\n`);
    const needle = `___DONE_${id}_`;
    const started = Date.now();
    const poll = setInterval(() => {
      const idx = out.indexOf(needle, begin);
      if (idx >= 0) {
        clearInterval(poll);
        const m = out.slice(idx).match(/___DONE_\d+_(\d+)___/);
        resolve({ code: m ? Number(m[1]) : null, text: out.slice(begin, idx).trimEnd() });
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        resolve({ code: "timeout", text: out.slice(begin).trimEnd() });
      }
    }, 500);
  });
}

// ── browser leg ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));

log("signing in (development sign-in)");
await page.goto(`${PORTAL}/signin`, { waitUntil: "networkidle" });
const devDetails = page.locator("details", { hasText: "Development sign-in" }).first();
await devDetails.waitFor({ state: "attached", timeout: 30_000 });
if (!(await devDetails.evaluate((el) => el.open))) await devDetails.locator("summary").click();
await page.locator("#dev-login").fill(LOGIN);
await page.locator("#dev-login").press("Enter");
await page.waitForURL(/dashboard|join|connect|setup/, { timeout: 30_000 }).catch(() => {});
// The sheet's commands and its evidence scope follow the selected track; the
// walkthrough runs the vision-recognition commands, so pin that track before
// any /setup visit (the default is the course's last-active module).
await page.evaluate(() => window.localStorage.setItem("cogportal.track", "vision-recognition"));
log("track pinned to vision-recognition");
log(`after sign-in at ${page.url()}`);

log("joining cohort VISION26 (or resuming an onboarded seat)");
await page.goto(`${PORTAL}/join`, { waitUntil: "networkidle" });
if (new URL(page.url()).pathname.endsWith("/join")) {
  await page.locator("#join-code").fill("VISION26", { timeout: 90_000 });
  await page.locator("#join-code").press("Enter");
  await page.waitForURL(/connect|dashboard|setup/, { timeout: 30_000 }).catch(() => {});
  log(`after join at ${page.url()}`);
} else {
  log(`already onboarded; at ${page.url()}`);
}

log("starting a new team on the fixture repository (or resuming)");
await page.goto(`${PORTAL}/setup`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
if (await page.locator("#step-clone").count()) {
  log(`setup checklist already present; at ${page.url()}`);
} else {
  await page.goto(`${PORTAL}/connect?path=start`, { waitUntil: "networkidle" });
  const repoCard = page.locator("label,li,article,button").filter({ hasText: "cogworks-demo/face-finder" }).first();
  await repoCard.waitFor({ timeout: 60_000 });
  await repoCard.click();
  await page.locator("#team-name").fill("Face Finder Video QA", { timeout: 90_000 });
  await page.getByRole("button", { name: /connect|start|create/i }).last().click();
  await page.waitForURL(/setup/, { timeout: 30_000 });
  log(`team settled; at ${page.url()}`);
}
await page.waitForTimeout(2500);

// ── milestone: 0 of 5 ───────────────────────────────────────────────────────
let state = await readChecklist(page);
journey.steps.push({ at: since(), milestone: "page-open", state: structuredClone(state) });
log(`page-open witness: ${JSON.stringify(state)}`);
await shot(page, "checklist-0of5-1440.png");
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await shot(page, "checklist-0of5-390.png");
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
state = await readChecklist(page);

const record = async (id, stateBefore, watch, extra = {}) => {
  const step = {
    at: since(),
    command: id,
    before: stateBefore,
    after: watch.after,
    ticked: watch.changed && JSON.stringify(watch.after.rows) !== JSON.stringify(stateBefore.rows),
    secondsToChange: watch.seconds,
    changedLive: watch.changed,
    ...extra,
  };
  journey.steps.push(step);
  log(`${id}: changed=${watch.changed} in ${watch.seconds}s -> ${JSON.stringify(watch.after)}`);
};

// ── 1. clone ────────────────────────────────────────────────────────────────
const cloneCmd = "git clone https://github.com/cogworks-demo/face-finder.git && cd face-finder";
log(`$ ${cloneCmd}`);
const r1 = await runCommand(cloneCmd, 120_000);
dump("cli-clone.txt", r1.text + `\nexit=${r1.code}`);
const w1 = await watchFor(page, state, 15_000);
await record("clone", state, w1, { exit: r1.code });
state = w1.after;

// ── 2. tool ────────────────────────────────────────────────────────────────
const toolCmd = `python -m pip install --upgrade --force-reinstall "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@ac8ddafa014ac72613bf8f291f945344a914cc63#subdirectory=python/cogbench"`;
log("$ python -m pip install --upgrade --force-reinstall cogworks-benchmark ...");
const r2 = await runCommand(toolCmd, 600_000);
dump("cli-tool.txt", r2.text + `\nexit=${r2.code}`);
const w2 = await watchFor(page, state, 15_000);
await record("tool", state, w2, { exit: r2.code });
state = w2.after;

// ── 3. benchmark ───────────────────────────────────────────────────────────
const week2 = "git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git@a3dd948d0c108fabf070b4f159acdecd4d6c3897";
const benchCmd = `python -m pip install "cogworks-week2-vision-benchmark[data] @ ${week2}" && python -m pip install --force-reinstall --no-deps "cogworks-week2-vision-benchmark @ ${week2}"`;
log("$ python -m pip install cogworks-week2-vision-benchmark[data] ...");
const r3 = await runCommand(benchCmd, 900_000);
dump("cli-benchmark.txt", r3.text + `\nexit=${r3.code}`);
const w3 = await watchFor(page, state, 15_000);
await record("benchmark", state, w3, { exit: r3.code });
state = w3.after;

// ── 4. link (approve in a second tab; the setup page stays open) ───────────
log("$ cogworks link --portal ... --no-browser");
const linkP = runCommand(`cogworks link --portal ${PORTAL} --no-browser`, 300_000);
const mre = /Open (\S+) and confirm code ([A-Za-z0-9-]+)/g;
let m4 = null;
for (let i = 0; i < 120 && !m4; i++) {
  await page.waitForTimeout(2500);
  const matches = [...out.matchAll(mre)];
  m4 = matches.at(-1) ?? null;
}
if (!m4) throw new Error(`link never printed its verification URI:\n${out.slice(-2000)}`);
const [, uri, code] = m4;
log(`link URI ${uri} code ${code}`);
const approve = await context.newPage();
await approve.goto(uri.replace("localhost:5173", "[::1]:5173"), { waitUntil: "networkidle" });
dump("approval-page.txt", await approve.locator("body").innerText());
await approve.locator("#device-name").fill("burst14 seat (py3.11)");
await approve.getByRole("button", { name: "Approve device" }).click();
log("device approved in the second tab");
await approve.waitForTimeout(1500);
await approve.close();
const r4 = await linkP;
dump("cli-link.txt", r4.text + `\nexit=${r4.code}`);
const w4 = await watchFor(page, state, 20_000);
await record("link", state, w4, { exit: r4.code, deviceCode: code });
state = w4.after;

// ── milestone: midway ──────────────────────────────────────────────────────
await shot(page, "checklist-mid-1440.png");
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await shot(page, "checklist-mid-390.png");
await page.setViewportSize({ width: 1440, height: 900 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
state = await readChecklist(page);

// ── 5. check ───────────────────────────────────────────────────────────────
const checkCmd = "cogworks check --benchmark vision-recognition --update-setup";
log(`$ ${checkCmd}`);
const r5 = await runCommand(checkCmd, 900_000);
dump("cli-check.txt", r5.text + `\nexit=${r5.code}`);
const w5 = await watchFor(page, state, 180_000);
await record("check", state, w5, { exit: r5.code });
state = w5.after;

// ── milestone: 5 of 5 ──────────────────────────────────────────────────────
await shot(page, "checklist-5of5-1440.png");
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await shot(page, "checklist-5of5-390.png");

fs.writeFileSync(path.join(OUT, "journey.json"), JSON.stringify(journey, null, 2));
log("journey.json written");
await browser.close();
shell.kill();
process.exit(0);
