#!/usr/bin/env node
// CogPortal local readiness gate.
//
// One command that runs the three local readiness surfaces the real-user
// readiness plan (docs/plan/real-user-readiness.md) gates on, reports each one
// separately, and fails — naming the affected surface — when any surface is
// broken or its evidence cannot be verified:
//
//   portal  (S1–S6)  the concurrent-member Playwright journeys against the real
//                    local stack: Vite + Worker + fresh local D1 on an isolated
//                    port, dev sign-in, no route mocks.
//   cli     (S7)     the real `cogworks check --json` readiness decision on
//                    synthetic fixture repositories: a ready one, one whose
//                    submission raises on import, and one whose submission ends
//                    the interpreter. All local; the check command has no
//                    --portal flag to begin with.
//   cogbot  (S8)     the interaction Worker's documented local verification:
//                    typecheck, the node:test suite, and the wrangler build.
//
// Local and deterministic by construction: synthetic identities (dev sign-ins,
// team-synthetic-2026), local D1 reseeded per run, repo fixtures. The only
// network use is dependency installation from the repo's own lockfiles and
// editable local pip builds. Nothing here touches production, hidden data,
// GitHub, Discord, Modal, CI workflows, or deploys. See README.md.

import { execFile } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const GATE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(GATE_ROOT, "..", "..");
const CACHE_DIR = join(GATE_ROOT, ".cache");
const SUITE_ROOT = join(REPO_ROOT, "tools", "portal-concurrent-member-journeys");
const PORTAL_APP = join(REPO_ROOT, "apps", "portal");
const BENCH_V1 = join(REPO_ROOT, "benchmarks", "vision-recognition");
const EXAMPLE_SUBMISSION = join(REPO_ROOT, "examples", "week2-vision-submission");

const DEFAULT_PORT = 5399;
const SURFACES = ["portal", "cli", "cogbot"];

// Wrangler and the discord-bot tests need Node 22+; the portal stack's boot
// script fixes its own PATH, so give every child the same head start.
function childEnv() {
  const env = { ...process.env };
  const node22 = join(process.env.HOME ?? "", ".local", "node22", "bin");
  if (existsSync(node22)) env.PATH = `${node22}:${env.PATH ?? ""}`;
  return env;
}

function parseArgs(argv) {
  const args = { surfaces: [...SURFACES], injectFailure: null, report: null, printReport: false, skipInstall: false };
  for (const arg of argv) {
    if (arg === "--") continue; // pnpm passes the separator through verbatim
    const [flag, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=") || "";
    if (flag === "surface") {
      const names = value.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = names.filter((n) => !SURFACES.includes(n));
      if (!names.length || unknown.length) {
        throw new Error(`unknown surface(s): ${unknown.join(", ") || "(none)"}; expected a comma list from ${SURFACES.join(", ")}`);
      }
      args.surfaces = names;
    } else if (flag === "inject-failure") {
      if (!SURFACES.includes(value)) throw new Error(`--inject-failure expects one of ${SURFACES.join(", ")}`);
      args.injectFailure = value;
    } else if (flag === "report") {
      if (!value) throw new Error("--report expects a file path");
      args.report = resolve(value);
    } else if (flag === "print-report") {
      args.printReport = true;
    } else if (flag === "skip-install") {
      args.skipInstall = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.injectFailure && !args.surfaces.includes(args.injectFailure)) {
    throw new Error(`--inject-failure=${args.injectFailure} is not in the requested surfaces: ${args.surfaces.join(", ")}`);
  }
  return args;
}

function run(cmd, cmdArgs, { cwd, timeoutMs = 120_000 } = {}) {
  return execFileP(cmd, cmdArgs, {
    cwd,
    env: childEnv(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      timedOut: error.killed === true || error.signal === "SIGTERM",
      message: String(error.message ?? error),
    }),
  );
}

function portBusy(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("error", () => { socket.destroy(); resolvePromise(false); });
  });
}

/** Playwright's JSON report may share stdout with other output; take the last
 *  balanced JSON object that parses and carries the fields the reporter writes. */
function parsePlaywrightReport(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && parsed.stats) return parsed;
  } catch {
    // fall through to line scanning
  }
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.stats) return parsed;
    } catch {
      // keep scanning upwards
    }
  }
  return null;
}

/** Node's spec reporter ends with a TAP-style summary; fail counts come from
 *  there so the gate never passes on silence. */
function parseNodeTestSummary(stdout) {
  const pass = /#\s+pass (\d+)/.exec(stdout);
  const fail = /#\s+fail (\d+)/.exec(stdout);
  const tests = /#\s+tests (\d+)/.exec(stdout);
  if (!pass || !fail || !tests) return null;
  return { pass: Number(pass[1]), fail: Number(fail[1]), tests: Number(tests[1]) };
}

// --------------------------------------------------------------------------
// Surface: portal (S1–S6) — the concurrent-member journeys on a private stack
// --------------------------------------------------------------------------

async function preparePortal(port, log) {
  if (args.skipInstall) return;
  if (!existsSync(join(PORTAL_APP, "node_modules"))) {
    log("installing workspace dependencies (pnpm install --frozen-lockfile)");
    const result = await run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO_ROOT, timeoutMs: 600_000 });
    if (result.code !== 0) throw new Error(`pnpm install failed: ${result.stderr.slice(-400)}`);
  }
  if (!existsSync(join(SUITE_ROOT, "node_modules"))) {
    log("installing the journeys suite's own dev dependencies (npm ci)");
    const result = await run("npm", ["ci"], { cwd: SUITE_ROOT, timeoutMs: 300_000 });
    if (result.code !== 0) throw new Error(`npm ci in the journeys suite failed: ${result.stderr.slice(-400)}`);
  }
  const launchProbe = () =>
    run(
      process.execPath,
      ["-e", "import('@playwright/test').then(async ({chromium})=>{const b=await chromium.launch({headless:true});await b.close();process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"],
      { cwd: SUITE_ROOT, timeoutMs: 120_000 },
    );
  let probe = await launchProbe();
  if (probe.code !== 0) {
    log("installing the Chromium build Playwright will drive");
    const install = await run("npx", ["playwright", "install", "chromium"], { cwd: SUITE_ROOT, timeoutMs: 600_000 });
    if (install.code !== 0) throw new Error(`playwright install chromium failed: ${install.stderr.slice(-400)}`);
    probe = await launchProbe();
  }
  if (probe.code !== 0) {
    // The browser binary is present but its OS libraries are not; on this
    // class of shared machine apt is reachable with passwordless sudo.
    const sudo = await run("sudo", ["-n", "true"], { timeoutMs: 15_000 });
    if (sudo.code !== 0) throw new Error(`portal: Chromium cannot launch and passwordless sudo is unavailable to install its system libraries — ${probe.stderr.slice(-300)}`);
    log("installing Chromium's system libraries (sudo playwright install-deps)");
    const deps = await run("sudo", ["npx", "playwright", "install-deps", "chromium"], { cwd: SUITE_ROOT, timeoutMs: 600_000 });
    if (deps.code !== 0) throw new Error(`playwright install-deps chromium failed: ${deps.stderr.slice(-400)}`);
    probe = await launchProbe();
    if (probe.code !== 0) throw new Error(`portal: Chromium still cannot launch after installing its system libraries — ${probe.stderr.slice(-300)}`);
  }
  // boot.sh creates .dev.vars on first use with a random secret; write it here
  // first with a fixed local-only value so every run provisions the same world.
  const devVars = join(PORTAL_APP, ".dev.vars");
  if (!existsSync(devVars)) {
    const example = join(PORTAL_APP, ".dev.vars.example");
    if (!existsSync(example)) throw new Error("apps/portal/.dev.vars.example is missing; cannot prepare the local stack");
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(example, "utf8")
      .split("http://localhost:5173").join(`http://localhost:${port}`)
      .split('BETTER_AUTH_SECRET=""').join('BETTER_AUTH_SECRET="readiness-gate-local-only-secret"');
    await writeFile(devVars, content);
    log("wrote apps/portal/.dev.vars from the example with a fixed local-only secret");
  }
}

async function checkPortal(reportSurface) {
  const port = Number(process.env.JOURNEYS_PORT ?? DEFAULT_PORT);
  if (await portBusy(port)) {
    reportSurface.status = "fail";
    reportSurface.reason = `portal: local port ${port} is already in use, so the gate would either share a stack it did not boot or fail to bind; free the port or set JOURNEYS_PORT`;
    return;
  }
  await preparePortal(port, (message) => reportSurface.steps.push(message));

  const started = Date.now();
  const result = await run("npx", ["playwright", "test", "--reporter=json"], {
    cwd: SUITE_ROOT,
    // boot.sh migrates and seeds a fresh local D1 before Vite starts, so this
    // command runs against the real app paths with no other server involved.
    timeoutMs: 900_000,
  });
  const report = parsePlaywrightReport(result.stdout);
  const stats = report?.stats ?? null;
  reportSurface.durationMs = Date.now() - started;
  reportSurface.commands.push({
    command: "npx playwright test --reporter=json (tools/portal-concurrent-member-journeys, JOURNEYS_REUSE_STACK=0)",
    exitCode: result.code,
  });
  reportSurface.evidence = {
    journeysExpected: stats?.expected ?? null,
    journeysUnexpected: stats?.unexpected ?? null,
    journeysFlaky: stats?.flaky ?? null,
    journeysSkipped: stats?.skipped ?? null,
  };
  if (result.timedOut) {
    reportSurface.status = "fail";
    reportSurface.reason = "portal: the journeys run timed out before producing a result";
    return;
  }
  if (!report) {
    reportSurface.status = "fail";
    reportSurface.reason = `portal: exit code ${result.code}, but no parsable Playwright report was produced, so the evidence is unverified${result.stderr ? `; stderr tail: ${result.stderr.slice(-300)}` : ""}`;
    return;
  }
  if (result.code !== 0 || (stats.unexpected ?? 0) > 0 || (stats.expected ?? 0) === 0) {
    reportSurface.status = "fail";
    reportSurface.reason = `portal: journeys finished with exit ${result.code}, ${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} unexpected, ${stats.skipped ?? 0} skipped`;
    return;
  }
  reportSurface.status = "pass";
  reportSurface.summary = `${stats.expected} journeys passed, 0 unexpected, on a fresh local stack (Vite + Worker + D1 on port ${port})`;
}

// --------------------------------------------------------------------------
// Surface: cli (S7) — the real cogworks check readiness decision on fixtures
// --------------------------------------------------------------------------

const FIXTURE_SUBMISSION = `"""Synthetic Week 2 vision submission: cosine nearest-reference with unknown rejection."""

from __future__ import annotations

import math
from typing import Any, List, Mapping, Sequence


class CosineRecognitionApp:
    unknown_threshold = 0.75

    def __init__(self, model: Any = None) -> None:
        self.model = model

    def predict(self, inputs: Sequence[Mapping[str, Any]]) -> List[str]:
        return [self.predict_one(item) for item in inputs]

    def predict_one(self, item: Mapping[str, Any]) -> str:
        embedding = self._vector(item.get("embedding"), "embedding")
        references = item.get("references")
        best_label, best_score = "unknown", float("-inf")
        for label in sorted(references):
            score = self._cosine(embedding, self._vector(references[label], "reference"))
            if score > best_score:
                best_label, best_score = label, score
        return best_label if best_score >= self.unknown_threshold else "unknown"

    @staticmethod
    def _vector(value: Any, field: str) -> tuple:
        if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or not value:
            raise ValueError(field + " must be a non-empty numeric sequence")
        vector = tuple(float(component) for component in value)
        if not all(math.isfinite(component) for component in vector):
            raise ValueError(field + " must contain only finite numbers")
        return vector

    @staticmethod
    def _cosine(left: tuple, right: tuple) -> float:
        if len(left) != len(right):
            raise ValueError("vectors must have the same length")
        lnorm = math.sqrt(sum(a * a for a in left))
        rnorm = math.sqrt(sum(b * b for b in right))
        if lnorm == 0.0 or rnorm == 0.0:
            raise ValueError("vectors must be non-zero")
        return sum(a * b for a, b in zip(left, right)) / (lnorm * rnorm)


def create_submission(model: Any = None) -> CosineRecognitionApp:
    return CosineRecognitionApp(model)
`;

// A student repository that is ordinary broken rather than adversarial: the
// module raises at import time on its own.
const RAISE_TAIL = `

def _boom():
    raise RuntimeError("ordinary broken student code")


_boom()
`;

// The adversarial end: student code that ends the interpreter instead of
// raising. The CLI must still answer with a categorized report.
const KILL_TAIL = `

import os
os._exit(9)
`;

async function prepareCli(log) {
  if (args.skipInstall) return;
  const venvBin = join(CACHE_DIR, "cli-venv", "bin");
  if (!existsSync(join(venvBin, "cogworks"))) {
    log("creating the CLI virtualenv and installing the repo's local packages into it");
    await mkdir(CACHE_DIR, { recursive: true });
    const steps = [
      ["python3", ["-m", "venv", join(CACHE_DIR, "cli-venv")]],
      [join(venvBin, "pip"), ["install", "-q", "-e", join(REPO_ROOT, "python", "cogbench")]],
      // The v1 fixture plugin pins cogworks-benchmark <0.2 while this checkout
      // is 0.2.0, so install it without dependency resolution; it imports only
      // cogbench.models, which 0.2.0 provides.
      [join(venvBin, "pip"), ["install", "-q", "--no-deps", "-e", BENCH_V1]],
      [join(venvBin, "pip"), ["install", "-q", "--no-deps", "-e", EXAMPLE_SUBMISSION]],
    ];
    for (const [cmd, cmdArgs] of steps) {
      const result = await run(cmd, cmdArgs, { cwd: REPO_ROOT, timeoutMs: 300_000 });
      if (result.code !== 0) throw new Error(`CLI environment setup failed at ${cmd} ${cmdArgs.join(" ")}: ${result.stderr.slice(-400)}`);
    }
  }
}

async function checkCli(reportSurface) {
  await prepareCli((message) => reportSurface.steps.push(message));
  const venvBin = join(CACHE_DIR, "cli-venv", "bin");
  const fixturesDir = join(CACHE_DIR, "cli-fixtures");

  const fixtures = [
    {
      name: "ready",
      tail: "",
      // The CLI's own exit rule (python/cogbench/src/cogbench/cli.py, the
      // `required` tuple in _check): a repository is ready only when all five
      // keys hold, and only then does check exit 0.
      verify: (exitCode, report) => {
        if (exitCode !== 0) return "expected exit 0";
        // The CLI's own exit rule (python/cogbench/src/cogbench/cli.py, the
        // `required` tuple in _check): all five keys must be truthy. Four are
        // booleans and must be strictly true; repositoryFullName is the parsed
        // "owner/name" string.
        const keys = ["gitRepository", "repositoryFullName", "benchmarkInstalled", "benchmarkLoadable", "submissionLoadable"];
        const falsyKeys = keys.filter((key) => !report[key]);
        if (falsyKeys.length) return `expected all of ${keys.join(", ")} to be truthy; falsy: ${falsyKeys.join(", ")}`;
        const booleans = keys.filter((key) => key !== "repositoryFullName");
        const notTrue = booleans.filter((key) => report[key] !== true);
        if (notTrue.length) return `expected ${notTrue.join(", ")} to be exactly true`;
        if (!/^[^/]+\/[^/]+$/.test(report.repositoryFullName)) return `expected repositoryFullName to be owner/name, got ${JSON.stringify(report.repositoryFullName)}`;
        return null;
      },
      okSummary: "ready: true, exit 0 (the CLI's own five-key readiness decision)",
    },
    {
      name: "raises-on-import",
      tail: RAISE_TAIL,
      verify: (exitCode, report) => {
        if (exitCode !== 2) return "expected exit 2";
        if (report.submissionLoadable !== false) return "expected submissionLoadable false";
        if (!String(report.submissionError ?? "").includes("RuntimeError")) return "expected a truthful submissionError naming the RuntimeError";
        return null;
      },
      okSummary: "raising submission: truthful categorized refusal, exit 2, no crash",
    },
    {
      name: "kills-interpreter",
      tail: KILL_TAIL,
      verify: (exitCode, report) => {
        if (exitCode !== 2) return "expected exit 2";
        if (report.submissionLoadable !== false) return "expected submissionLoadable false";
        if (!String(report.submissionError ?? "").includes("crashed")) return "expected the report to categorize the repository as crashed";
        return null;
      },
      okSummary: "interpreter-ending submission: categorized as crashed, exit 2, structured JSON still produced",
    },
  ];

  const evidence = {};
  for (const fixture of fixtures) {
    const fixtureRoot = join(fixturesDir, fixture.name);
    const { rmSync, mkdirSync, writeFileSync } = await import("node:fs");
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(join(fixtureRoot, "submission.py"), FIXTURE_SUBMISSION + fixture.tail);
    // A synthetic GitHub identity: the URL string is parsed locally, no fetch.
    await run("git", ["init", "-q"], { cwd: fixtureRoot });
    await run("git", ["-c", "user.email=gate@dev.local", "-c", "user.name=Readiness Gate", "add", "-A"], { cwd: fixtureRoot });
    await run("git", ["-c", "user.email=gate@dev.local", "-c", "user.name=Readiness Gate", "commit", "-qm", "fixture"], { cwd: fixtureRoot });
    await run("git", ["remote", "add", "origin", "https://github.com/CogWorksBWSI/team-synthetic-2026.git"], { cwd: fixtureRoot });

    const result = await run(join(venvBin, "cogworks"), ["check", "--benchmark", "vision-recognition", "--json"], {
      cwd: fixtureRoot,
      timeoutMs: 180_000,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      reportSurface.status = "fail";
      reportSurface.reason = `cli: fixture '${fixture.name}' produced no parsable check --json report (exit ${result.code}), so the CLI evidence is unverified`;
      return;
    }
    const problem = fixture.verify(result.code, parsed);
    reportSurface.commands.push({
      command: `cogworks check --benchmark vision-recognition --json (fixture ${fixture.name})`,
      exitCode: result.code,
    });
    evidence[fixture.name] = problem ? { problem } : { ok: true };
    if (problem) {
      reportSurface.status = "fail";
      reportSurface.reason = `cli: fixture '${fixture.name}' ${problem}`;
      reportSurface.evidence = evidence;
      return;
    }
  }
  reportSurface.status = "pass";
  reportSurface.evidence = evidence;
  reportSurface.summary = fixtures.map((f) => f.okSummary).join("; ");
}

// --------------------------------------------------------------------------
// Surface: cogbot (S8) — the interaction Worker's documented verification
// --------------------------------------------------------------------------

async function prepareCogbot(log) {
  if (args.skipInstall) return;
  if (!existsSync(join(REPO_ROOT, "apps", "discord-bot", "node_modules"))) {
    log("installing workspace dependencies (pnpm install --frozen-lockfile)");
    const result = await run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO_ROOT, timeoutMs: 600_000 });
    if (result.code !== 0) throw new Error(`pnpm install failed: ${result.stderr.slice(-400)}`);
  }
}

async function checkCogbot(reportSurface) {
  await prepareCogbot((message) => reportSurface.steps.push(message));
  const evidence = {};
  const steps = [
    { key: "typecheck", cmd: "pnpm", args: ["--filter", "@cogworks/discord-bot", "check"], timeoutMs: 300_000 },
    { key: "tests", cmd: "pnpm", args: ["--filter", "@cogworks/discord-bot", "test"], timeoutMs: 300_000 },
    { key: "build", cmd: "pnpm", args: ["--filter", "@cogworks/discord-bot", "build"], timeoutMs: 300_000 },
  ];
  for (const step of steps) {
    const started = Date.now();
    const result = await run(step.cmd, step.args, { cwd: REPO_ROOT, timeoutMs: step.timeoutMs });
    reportSurface.commands.push({
      command: `${step.cmd} ${step.args.join(" ")}`,
      exitCode: result.code,
      durationMs: Date.now() - started,
    });
    if (result.timedOut) {
      reportSurface.status = "fail";
      reportSurface.reason = `cogbot: ${step.key} timed out before producing a result`;
      return;
    }
    if (step.key === "tests") {
      const summary = parseNodeTestSummary(result.stdout);
      evidence.tests = summary ?? "unparsable";
      if (result.code !== 0) {
        reportSurface.status = "fail";
        reportSurface.reason = `cogbot: the node:test suite exited ${result.code}`;
        return;
      }
      if (!summary || summary.fail !== 0 || summary.pass === 0) {
        reportSurface.status = "fail";
        reportSurface.reason = `cogbot: test summary unreadable or failing (${JSON.stringify(summary)}), so the CogBot evidence is unverified`;
        return;
      }
    } else if (result.code !== 0) {
      reportSurface.status = "fail";
      reportSurface.reason = `cogbot: ${step.key} exited ${result.code}`;
      return;
    } else {
      evidence[step.key] = "ok";
    }
  }
  reportSurface.status = "pass";
  reportSurface.evidence = evidence;
  reportSurface.summary = `typecheck clean, ${evidence.tests.pass}/${evidence.tests.tests} node:test cases pass, wrangler build succeeds`;
}

// --------------------------------------------------------------------------

let args;

async function main() {
  args = parseArgs(process.argv.slice(2));
  await mkdir(CACHE_DIR, { recursive: true });
  const reportPath = args.report ?? join(CACHE_DIR, "readiness-report.json");
  const startedAt = new Date().toISOString();
  console.log(`CogPortal local readiness gate — surfaces: ${args.surfaces.join(", ")}`);

  const surfaces = [];
  for (const name of args.surfaces) {
    const reportSurface = {
      surface: name,
      planReference: name === "portal" ? "S1-S6" : name === "cli" ? "S7" : "S8",
      status: "pending",
      steps: [],
      commands: [],
      evidence: null,
      summary: null,
      reason: null,
      durationMs: null,
      injected: false,
    };
    const started = Date.now();
    console.log(`  running ${name}...`);
    try {
      if (args.injectFailure === name) {
        reportSurface.status = "fail";
        reportSurface.injected = true;
        reportSurface.reason = `cli: injected failure for ${name} (gate self-test)`.replace("cli", name);
        reportSurface.summary = null;
      } else if (name === "portal") {
        await checkPortal(reportSurface);
      } else if (name === "cli") {
        await checkCli(reportSurface);
      } else if (name === "cogbot") {
        await checkCogbot(reportSurface);
      }
    } catch (error) {
      reportSurface.status = "fail";
      reportSurface.reason = `${name}: could not run to completion — ${String(error.message ?? error).slice(0, 500)}`;
    }
    reportSurface.durationMs = (reportSurface.durationMs ?? Date.now() - started);
    surfaces.push(reportSurface);
    console.log(`  ${name}: ${reportSurface.status.toUpperCase()}${reportSurface.reason ? ` — ${reportSurface.reason}` : ""}`);
  }

  const failed = surfaces.filter((s) => s.status === "fail");
  const overall = failed.length === 0 ? "ready" : "not-ready";
  const finishedAt = new Date().toISOString();
  const report = {
    gate: "cogportal-local-readiness",
    plan: "docs/plan/real-user-readiness.md",
    overall,
    surfaces,
    startedAt,
    finishedAt,
    injectedFailure: args.injectFailure,
    node: process.version,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log("");
  for (const surface of surfaces) {
    const label = `${surface.surface} (${surface.planReference})`.padEnd(20);
    console.log(`  ${label} ${surface.status.toUpperCase().padEnd(5)} ${surface.summary ?? surface.reason ?? ""}`);
  }
  console.log("");
  if (overall === "ready") {
    console.log("READY — every requested surface verified.");
  } else {
    console.log(`NOT READY — failing surfaces: ${failed.map((s) => s.surface).join(", ")}`);
  }
  console.log(`Machine-readable report: ${reportPath}`);
  if (args.printReport) console.log(JSON.stringify(report, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`readiness gate could not run: ${error.message}`);
  process.exitCode = 2;
});
