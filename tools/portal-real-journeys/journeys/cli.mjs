// The real `cogworks` CLI, for the journeys that drive it.
//
// It runs in the Python 3.8 environment stack/setup-python.sh builds (this
// checkout's CLI and the Week 1 benchmark, editable). A missing or wrong
// environment fails the journey that needs it: an acceptance run that skipped
// the CLI would report a pass for a path it never drove.
//
// Every invocation gets its own HOME and COGBENCH_CONFIG in a temp directory,
// so it never reads or writes the developer's ~/.cogbench or caches, and an
// allowlisted environment, so nothing from the caller's shell (a
// COGPORTAL_URL, a proxy) reaches it.

import { expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CLI_SRC = path.join(REPO_ROOT, "python", "cogbench", "src");
export const PYTHON = process.env.RJ_PYTHON ?? path.resolve(HERE, "..", ".py38", "bin", "python");
const WEEK1_EXAMPLE = path.join(REPO_ROOT, "examples", "week1-audio-submission");

/**
 * Fails the calling journey unless PYTHON is Python 3.8 running this
 * checkout's CLI with the Week 1 benchmark and its reference submission's
 * requirements importable.
 */
export function requirePython() {
  const setup = "run tools/portal-real-journeys/stack/setup-python.sh, or set RJ_PYTHON";
  expect(fs.existsSync(PYTHON), `no Python environment at ${PYTHON}; ${setup}`).toBe(true);
  let facts;
  try {
    facts = JSON.parse(
      execFileSync(
        PYTHON,
        [
          "-c",
          "import json, sys, cogbench, audio_identification_benchmark, numpy, scipy, matplotlib; " +
            "print(json.dumps({'version': '%d.%d' % sys.version_info[:2], 'cli': cogbench.__file__}))",
        ],
        { env: { PATH: process.env.PATH }, encoding: "utf8" },
      ),
    );
  } catch (error) {
    throw new Error(`${PYTHON} cannot import the CLI, the Week 1 benchmark or its requirements; ${setup}\n${error.stderr ?? error}`);
  }
  expect(facts.version, `${PYTHON} must be Python 3.8, the course's version`).toBe("3.8");
  expect(fs.realpathSync(facts.cli).startsWith(fs.realpathSync(CLI_SRC)), `${PYTHON} imports cogbench from ${facts.cli}, not this checkout`).toBe(true);
}

/** A HOME of its own for one student machine. */
export function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rj-cli-"));
}

function cliEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    COGBENCH_CONFIG: path.join(home, "config.json"),
    PYTHONUNBUFFERED: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

/** Runs `cogworks <args>` to its end. */
export function cogworks(args, { cwd, home, env = {}, timeoutMs = 600_000 }) {
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ["-m", "cogbench", ...args], { cwd, env: cliEnv(home, env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, args });
    });
  });
}

/** Starts `cogworks link` and resolves `prompt` once it prints the approval link. */
export function startLink(portal, { cwd, home }) {
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
  const child = spawn(PYTHON, ["-m", "cogbench", "link", "--portal", portal, "--no-browser"], {
    cwd,
    env: cliEnv(home),
  });
  let output = "";
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const prompt = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Open (\S+) and confirm code (\S+)\./);
      if (match) resolve({ uri: match[1], code: match[2] });
    });
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    exited.then((code) => reject(new Error(`cogworks link exited ${code} before prompting:\n${output}`)));
  });
  return { prompt, exited, output: () => output, kill: () => child.kill("SIGTERM") };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "RJ Synthetic",
      GIT_AUTHOR_EMAIL: "rj-synthetic@example.invalid",
      GIT_COMMITTER_NAME: "RJ Synthetic",
      GIT_COMMITTER_EMAIL: "rj-synthetic@example.invalid",
    },
  }).trim();
}

/**
 * A team repository on disk: the Week 1 reference submission (staff code,
 * no student's work) committed on `main`, with `origin` naming the team's
 * GitHub repository. Nothing is fetched or pushed; the remote is only read,
 * the way the CLI reads it to attribute a report.
 */
export function makeWeek1Project(home, repoFullName) {
  const root = path.join(home, "project");
  fs.mkdirSync(root);
  fs.copyFileSync(path.join(WEEK1_EXAMPLE, "submission.py"), path.join(root, "submission.py"));
  fs.cpSync(path.join(WEEK1_EXAMPLE, "reference_shazam"), path.join(root, "reference_shazam"), {
    recursive: true,
    filter: (source) => !source.includes("__pycache__"),
  });
  fs.writeFileSync(path.join(root, ".gitignore"), ".cogbench/\n__pycache__/\n");
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["remote", "add", "origin", `https://github.com/${repoFullName}.git`]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "Week 1 reference submission"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}
