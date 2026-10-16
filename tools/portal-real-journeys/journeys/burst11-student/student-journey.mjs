// Walks one new student through the portal the way a person would: sign in,
// join the cohort, start a team, link a real CLI device, run a Week benchmark
// locally and sync it, start practice runs, promote to official, publish, and
// read the leaderboard signed out. Screenshots every step at 1440x900 and
// 390x844 and prints a VERDICT line per step.
//
// It adapts the CLI plumbing (link/run/sync subprocess driving) from
// journeys/cli.mjs on the real-journeys branch and reuses that branch's
// provider doubles for the no-outbound-traffic check; without the doubles the
// journal steps are skipped.
//
// Prerequisites:
//   - the dev stack up: pnpm dev with local D1 migrations + seed (fixture
//     provider, dev auth enabled), PORTAL_URL overriding http://localhost:5173
//   - a Python venv with cogbench and the week benchmarks installed, whose
//     interpreter is PYTHON_BIN (the venv the student's CLI would use)
//   - playwright resolvable from the module's directory
//   - DOUBLES_BASE (default http://127.0.0.1:8811) when the doubles run;
//     the github/discord/modal doubles answer on the next three ports
//
// Usage: node student-journey.mjs
// Verdicts land in OUT_DIR/verdicts.json as {step, verdict, note} triples.
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STACK = process.env.PORTAL_URL ?? "http://localhost:5173";
const PYTHON = process.env.PYTHON_BIN ?? "python3.8";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/cogportal-student-journey";
const TEAM = process.env.TEAM_NAME ?? "Field Notes";
const STUDENT = process.env.STUDENT_NAME ?? "field-notes-student";
const JOIN_CODE = process.env.JOIN_CODE ?? "vision26";
const WEEK_EXAMPLE = process.env.WEEK1_EXAMPLE ?? path.resolve("examples/week1-audio-submission");
const DOUBLES_BASE = process.env.DOUBLES_BASE ?? null;
const DOUBLE_PORTS = DOUBLES_BASE
  ? { "github-rest": 8811, discord: 8813, "modal-runner": 8814 }
  : null;

fs.mkdirSync(OUT_DIR, { recursive: true });
const verdicts = [];
function verdict(step, state, note) {
  verdicts.push({ step, verdict: state, note });
  console.log(`VERDICT|${step}|${state}|${note}`);
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  console.log(`SHOT|${name}`);
}

function cliEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    COGBENCH_CONFIG: path.join(home, "config.json"),
    PYTHONUNBUFFERED: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
function cogworks(args, { cwd, home, timeoutMs = 600_000 }) {
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ["-m", "cogbench", ...args], { cwd, env: cliEnv(home) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function startLink(portal, { home }) {
  const child = spawn(PYTHON, ["-m", "cogbench", "link", "--portal", portal, "--no-browser"], { cwd: home, env: cliEnv(home) });
  let output = "";
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const prompt = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const m = output.match(/Open (\S+) and confirm code (\S+)\./);
      if (m) resolve({ uri: m[1], code: m[2] });
    });
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    exited.then((code) => reject(new Error(`cogworks link exited ${code} before prompting:\n${output}`)));
  });
  return { prompt, exited, output: () => output, kill: () => child.kill("SIGTERM") };
}
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: {
      PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Journey Student", GIT_AUTHOR_EMAIL: "journey-student@example.invalid",
      GIT_COMMITTER_NAME: "Journey Student", GIT_COMMITTER_EMAIL: "journey-student@example.invalid",
    },
  }).trim();
}
function makeWeek1Project(home, repoFullName) {
  const root = path.join(home, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(WEEK_EXAMPLE, "submission.py"), path.join(root, "submission.py"));
  fs.cpSync(path.join(WEEK_EXAMPLE, "reference_shazam"), path.join(root, "reference_shazam"), {
    recursive: true, filter: (s) => !s.includes("__pycache__"),
  });
  fs.writeFileSync(path.join(root, ".gitignore"), ".cogbench/\n__pycache__/\n");
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["remote", "add", "origin", `https://github.com/${repoFullName}.git`]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Week 1 reference submission"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });

let link = null;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "student-journey-cli-"));
try {
  await page.goto(`${STACK}/`);
  await page.waitForLoadState("networkidle");
  await shot(page, "01-landing");
  await mobile.goto(`${STACK}/`);
  await mobile.waitForLoadState("networkidle");
  await shot(mobile, "01-landing-mobile");
  verdict("landing", "works", "signed-out landing renders");

  await page.goto(`${STACK}/signin`);
  await page.getByText("Development sign-in").waitFor({ timeout: 10_000 });
  await shot(page, "02-signin");
  const field = page.getByLabel("Sign in as");
  await field.waitFor({ state: "visible", timeout: 10_000 });
  await field.fill(STUDENT);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(join|dashboard)/, { timeout: 15_000 });
  await shot(page, "02-signin-joined");
  verdict("signin", "works", "dev sign-in signs the student in; GitHub OAuth itself stays untested locally (unconfigured)");

  await page.getByLabel("Join code").fill(JOIN_CODE);
  await page.getByRole("button", { name: "Join the cohort" }).click();
  await page.waitForURL(/\/(connect|setup)/, { timeout: 15_000 });
  await shot(page, "03-join-connected");
  verdict("join-cohort", "works", `join code ${JOIN_CODE} accepted`);

  await page.getByText("Start a new team").click();
  await page.getByRole("radio", { name: /face-finder/ }).check();
  await page.getByLabel("Team name").fill(TEAM);
  await shot(page, "04-repo-pick");
  await page.getByRole("button", { name: `Create ${TEAM}` }).click();
  await page.waitForURL(/\/setup/, { timeout: 20_000 });
  await shot(page, "04-repo-pick-team-created");
  const session = await (await page.request.get(`${STACK}/api/session`)).json();
  verdict("fork-pick-repo", "works", `team created on the fixture repository ${session.team?.repo?.fullName ?? "?"}; a real fork is not available locally`);

  const project = makeWeek1Project(home, session.team.repo.fullName);
  link = startLink(STACK, { home });
  const { uri, code } = await link.prompt;
  await page.goto(uri);
  await page.getByRole("heading", { name: "Approve this device" }).waitFor({ timeout: 10_000 });
  await page.getByText(code, { exact: true }).waitFor({ timeout: 5_000 });
  await shot(page, "05-device-approval");
  await mobile.goto(uri);
  await mobile.getByRole("heading", { name: "Approve this device" }).waitFor({ timeout: 10_000 });
  await shot(mobile, "05-device-approval-mobile");
  await page.getByRole("button", { name: "Approve device" }).click();
  const linkCode = await link.exited;
  const linkOut = link.output();
  await shot(page, "05-device-approval-approved");
  const linkOk = linkCode === 0 && /Linked .+\. Local commands still work offline\./.test(linkOut);
  verdict("device-approval", linkOk ? "works" : "broken", linkOk
    ? "the venv CLI printed the approval URI and code, the portal approved it, the CLI exited 0 with its Linked confirmation"
    : `CLI exit ${linkCode}: ${linkOut.slice(0, 300)}`);

  await page.goto(`${STACK}/setup`);
  await page.waitForLoadState("networkidle");
  await shot(page, "06-setup-checklist");
  await mobile.goto(`${STACK}/setup`);
  await mobile.waitForLoadState("networkidle");
  await shot(mobile, "06-setup-checklist-mobile");
  verdict("setup-checklist", "works", "checklist renders signed-in with the linked-device state on a fresh load");

  const smoke = await cogworks(["test", "--benchmark", "audio-identification", "--json"], { cwd: project.root, home });
  if (smoke.code !== 0) throw new Error(`cogworks test failed: ${smoke.stdout}\n${smoke.stderr}`);
  const run = await cogworks(["run", "--benchmark", "audio-identification", "--json"], { cwd: project.root, home });
  if (run.code !== 0) throw new Error(`cogworks run failed: ${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  const sync = await cogworks(["sync"], { cwd: project.root, home });
  const syncOk = sync.code === 0 && sync.stdout.includes(`Synced ${report.reportId} as LOCAL RUN · SELF-REPORTED.`);
  await page.goto(`${STACK}/dashboard`);
  await page.waitForLoadState("networkidle");
  await shot(page, "07-local-run-sync");
  await mobile.goto(`${STACK}/dashboard`);
  await mobile.waitForLoadState("networkidle");
  await shot(mobile, "07-local-run-sync-mobile");
  verdict("local-run-sync", syncOk ? "works" : "broken", syncOk
    ? `real cogworks test+run produced report ${report.reportId} with ${report.metrics.length} metrics; sync filed it as LOCAL RUN · SELF-REPORTED`
    : `sync exit ${sync.code}: ${sync.stdout.slice(0, 200)} ${sync.stderr.slice(0, 200)}`);

  await page.goto(`${STACK}/dashboard`);
  await page.getByLabel("Branch").selectOption("main");
  await page.getByRole("button", { name: "Run practice benchmark" }).click();
  await page.waitForTimeout(1500);
  let runs = await (await page.request.get(`${STACK}/api/runs`)).json();
  const practice = runs.find((r) => r.mode === "practice" && r.branch === "main");
  await page.goto(`${STACK}/runs/${practice.id}`);
  await page.getByText("Succeeded").first().waitFor({ timeout: 90_000 });
  await page.getByText("What this run shows").waitFor({ timeout: 10_000 });
  await shot(page, "08-run-detail");
  await mobile.goto(`${STACK}/runs/${practice.id}`);
  await mobile.getByText("Succeeded").first().waitFor({ timeout: 30_000 });
  await shot(mobile, "08-run-detail-mobile");
  verdict("run-detail", "works", "practice run advanced on the fixture runner to Succeeded; the page leads with what the run shows");

  await page.goto(`${STACK}/dashboard`);
  await page.getByLabel("Branch").selectOption("missing-adapter");
  await page.getByRole("button", { name: "Run practice benchmark" }).click();
  await page.waitForTimeout(1500);
  runs = await (await page.request.get(`${STACK}/api/runs`)).json();
  const failedRun = runs.find((r) => r.mode === "practice" && r.branch === "missing-adapter");
  await page.goto(`${STACK}/runs/${failedRun.id}`);
  await page.getByText("Nothing here could be scored").waitFor({ timeout: 90_000 });
  await shot(page, "09-failed-run");
  await page.getByRole("button", { name: "Show details" }).click().catch(() => {});
  await shot(page, "09-failed-run-details");
  await mobile.goto(`${STACK}/runs/${failedRun.id}`);
  await mobile.getByText("Nothing here could be scored").waitFor({ timeout: 30_000 });
  await shot(mobile, "09-failed-run-mobile");
  verdict("failed-practice-run", "works", "the failed run renders the neutral failure card with its category and keeps the raw line folded");

  await page.goto(`${STACK}/dashboard`);
  await page.getByRole("button", { name: "Promote to official" }).first().click();
  await shot(page, "10-promote-confirm");
  await page.getByRole("button", { name: /Confirm, uses attempt 1 of/ }).click();
  let official = null;
  for (let i = 0; i < 60 && !official; i++) {
    await page.waitForTimeout(2000);
    runs = await (await page.request.get(`${STACK}/api/runs`)).json();
    official = runs.find((r) => r.mode === "official" && r.status === "succeeded");
  }
  if (!official) throw new Error("no official run reached succeeded");
  await shot(page, "10-promoted");
  verdict("promote", "works", `practice run promoted to official run ${official.id} (the confirm names the attempt it uses)`);

  const detail = await (await page.request.get(`${STACK}/api/runs/${official.id}`)).json();
  if (!detail.surfaceId) throw new Error("official run has no console surface");
  await page.goto(`${STACK}/run-surfaces/${detail.surfaceId}`);
  await page.getByRole("button", { name: "Publish result" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  await shot(page, "11-publish-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 15_000 });
  await shot(page, "11-published");
  verdict("publish", "works", `published ${official.shortSha ?? official.sha} from the official run's console through its confirm dialog`);

  // The board defaults to its first module tab, which is not necessarily the
  // benchmark the team just published; find the entry on its own tab.
  const board = await (await page.request.get(`${STACK}/api/leaderboard?benchmark=${official.benchmarkId}`)).json();
  const entry = board.entries?.find((e) => e.teamName === TEAM);
  verdict("board-entry", entry ? "works" : "broken", entry
    ? `the published entry is on the ${official.benchmarkId} board: rank ${entry.rank}, metric ${entry.primaryMetric?.value}`
    : `no entry for ${TEAM} on the ${official.benchmarkId} board`);
  await page.goto(`${STACK}/leaderboard?benchmark=${official.benchmarkId}`);
  await page.waitForLoadState("networkidle");
  await shot(page, "12-leaderboard-published");

  // account menu sign out (the control is a link inside the menu popover)
  await page.getByRole("button", { name: new RegExp(`Account menu for ${STUDENT}`) }).click();
  await page.getByText("Sign out", { exact: true }).click();
  await page.waitForTimeout(2000);
  await shot(page, "13-signed-out");
  const stillIn = await page.evaluate((who) => document.body.innerText.includes(who), STUDENT);
  verdict("sign-out", stillIn ? "broken" : "works", stillIn ? "the page still names the student after sign out" : "the account menu signs the student out");

  // signed-out visitor reads the board
  const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const vp = await visitor.newPage();
  await vp.goto(`${STACK}/leaderboard?benchmark=${official.benchmarkId}`);
  await vp.waitForLoadState("networkidle");
  const row = vp.getByRole("listitem").filter({ has: vp.getByRole("heading", { name: TEAM }) });
  await row.waitFor({ timeout: 20_000 });
  await shot(vp, "14-leaderboard-signed-out");
  const details = row.getByRole("button", { name: new RegExp(`Details for ${TEAM}`) });
  if (await details.isVisible().catch(() => false)) {
    await details.click();
    await shot(vp, "14-leaderboard-signed-out-details");
  }
  const vm = await visitor.newPage();
  await vm.setViewportSize({ width: 390, height: 844 });
  await vm.goto(`${STACK}/leaderboard?benchmark=${official.benchmarkId}`);
  await vm.waitForLoadState("networkidle");
  await shot(vm, "14-leaderboard-signed-out-mobile");
  verdict("signed-out-leaderboard", "works", "a signed-out visitor sees the published entry and can open its Details");

  if (DOUBLE_PORTS) {
    for (const [name, port] of Object.entries(DOUBLE_PORTS)) {
      const journal = (await (await fetch(`http://127.0.0.1:${port}/__doubles/journal`)).json()).journal;
      verdict("provider-journal-" + name, journal.length === 0 ? "works" : "rough",
        journal.length === 0 ? "no requests reached the double" : `${journal.length} requests reached the double`);
    }
  }
  console.log("JOURNEY_OK");
} catch (error) {
  console.error("JOURNEY_FAIL", error);
  verdict("journey", "broken", String(error).slice(0, 500));
  try { await shot(page, "99-failure-state"); } catch {}
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "verdicts.json"), JSON.stringify(verdicts, null, 2));
  link?.kill();
  await browser.close();
  console.log("HOME_KEPT", home);
}
