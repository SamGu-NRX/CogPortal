#!/usr/bin/env node
// Student-seat portal leg, driven the way a student drives it: dev sign-in on
// the SPA, join VISION26, join the seeded team, then `cogworks link
// --no-browser` from the week1 repo; the printed verification URI is opened in
// the same signed-in browser and approved with the page's own button. Then
// status / sync / report, and dashboard screenshots.
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";

const PORTAL = "http://127.0.0.1:8850";
const COG = process.env.HOME + "/work/b11-venvs/venv311/bin/cogworks";
const WEEK1 = process.env.HOME + "/work/burst11-student/week1-audio";
const OUT = process.env.HOME + "/work/b11-durable/logs";
const EV = process.env.HOME + "/work/b11-durable/evidence";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(EV, { recursive: true });
const log = (m) => console.log(`[portal-leg] ${m}`);
const dump = (name, text) => fs.writeFileSync(`${OUT}/${name}`, text);
const run = (cmd) => execSync(cmd, { cwd: WEEK1, encoding: "utf8", timeout: 180_000 });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

log("dev sign-in");
await page.goto(`${PORTAL}/signin`, { waitUntil: "networkidle" });
dump("spa-signin.txt", await page.locator("body").innerText());
const inp = page.locator("#dev-login");
if (!(await inp.isVisible())) {
  const disc = page.locator("details", { hasText: "Development sign-in" });
  if (await disc.count()) await disc.first().locator("summary").click();
}
await inp.fill("burst11-student");
await page.locator("#dev-login").press("Enter");
await page.waitForURL(/dashboard|join|connect|setup/, { timeout: 30_000 }).catch(() => {});
dump("spa-after-signin.txt", await page.locator("body").innerText());
log(`after sign-in at ${page.url()}`);

log("join cohort VISION26");
if (!/\/join/.test(page.url())) await page.goto(`${PORTAL}/join`, { waitUntil: "networkidle" });
const joinCode = page.locator("#join-code");
if (await joinCode.isVisible().catch(() => false)) {
  await joinCode.fill("VISION26");
  await joinCode.press("Enter");
  await page.waitForURL(/connect|dashboard|setup/, { timeout: 30_000 }).catch(() => {});
} else {
  log("join form absent (already joined) — continuing");
}
dump("spa-after-join.txt", await page.locator("body").innerText());
log(`after join at ${page.url()}`);

if (/\/connect/.test(page.url())) {
  const start = page.getByRole("button", { name: /start (a new team|it yourself)/i });
  if (await start.count()) {
    log("start a new team on the fixture repo");
    await start.first().click();
    await page.waitForTimeout(1500);
    await page.getByText("cogworks-demo/face-finder").first().click().catch(() => page.getByText("face-finder").first().click());
    await page.waitForTimeout(1000);
    await page.locator("#team-name").fill("Vector Voyagers");
    await page.getByRole("button", { name: /create vector voyagers/i }).first().click();
    await page.waitForURL(/setup|dashboard/, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    dump("spa-after-team.txt", await page.locator("body").innerText());
    log(`after team create at ${page.url()}`);
  } else {
    log("start button absent — continuing");
  }
}

log("cogworks link");
const link = spawn(COG, ["link", "--portal", PORTAL, "--no-browser"], { cwd: WEEK1, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
let linkOut = "";
link.stdout.on("data", (d) => (linkOut += d));
link.stderr.on("data", (d) => (linkOut += d));
const printed = await new Promise((resolve, reject) => {
  const t = setInterval(() => {
    const m = linkOut.match(/Open (\S+) and confirm code ([A-Za-z0-9-]+)/);
    if (m) { clearInterval(t); resolve(m); }
  }, 300);
  link.on("exit", (c) => { clearInterval(t); reject(new Error(`link exited early ${c}: ${linkOut}`)); });
  setTimeout(() => { clearInterval(t); reject(new Error("no link URI in 90s")); }, 90_000);
});
const [, uri, code] = printed;
log(`link URI ${uri} code ${code}`);
dump("cli-link-output.txt", linkOut);

log("approve device on the connections page");
await page.goto(uri, { waitUntil: "networkidle" });
dump("spa-device-page.txt", await page.locator("body").innerText());
await page.locator("#device-name").fill("burst11 seat (py3.11)");
await page.getByRole("button", { name: "Approve device" }).click();
await page.waitForTimeout(3000);
dump("spa-after-approve.txt", await page.locator("body").innerText());

const linkExit = await new Promise((r) => link.on("exit", r));
log(`cogworks link exited ${linkExit}`);
fs.appendFileSync(`${OUT}/cli-link-output.txt`, `\nexit=${linkExit}\n${linkOut}`);

for (const cmd of ["status", "sync", "report"]) {
  try {
    dump(`cli-${cmd}.txt`, run(`${COG} ${cmd}`));
    log(`${cmd} ok`);
  } catch (e) {
    dump(`cli-${cmd}.txt`, String(e.stdout ?? "") + String(e.stderr ?? "") + `\nexit=${e.status}`);
    log(`${cmd} FAILED exit=${e.status}`);
  }
}

log("dashboard screenshots");
await page.goto(`${PORTAL}/dashboard`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
dump("spa-dashboard.txt", await page.locator("body").innerText());
await page.screenshot({ path: `${EV}/portal-runs-page.png`, fullPage: true });
const localReports = page.getByText(/LOCAL REPORTS|Reports/i).first();
if (await localReports.count()) {
  await localReports.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${EV}/portal-runs-local-reports.png`, fullPage: false });
}
await browser.close();
log("done");
