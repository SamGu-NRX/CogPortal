#!/usr/bin/env node
// Runs the whole suite N times in a row (default 3), each a fresh stack and
// fresh databases, zero retries, and writes one receipt per run binding the
// result to the commit it ran on:
//
//   node stack/acceptance.mjs [--runs 3] [--out <dir>]
//
// A receipt records the commit and tree, that the worktree was clean, start
// and end times, Playwright's exit code, and every test's title, status,
// retry count and duration, from Playwright's JSON reporter. A dirty
// worktree is refused: a receipt has to name exactly what ran.

import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, "..");
const REPO = path.resolve(SUITE, "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const runs = Number(option("runs", "3"));
const out = path.resolve(option("out", path.join(SUITE, "test-results", "receipts")));

const git = (...argv) => execFileSync("git", argv, { cwd: REPO, encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty) {
  console.error(`refusing: the worktree has uncommitted changes to tracked files:\n${dirty}`);
  process.exit(2);
}
const commit = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
fs.mkdirSync(out, { recursive: true });

function flatten(suite, file = suite.file) {
  const tests = [];
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      tests.push({
        file: spec.file ?? file,
        title: spec.title,
        status: t.status,
        results: t.results.map((r) => ({ status: r.status, retry: r.retry, durationMs: r.duration })),
      });
    }
  }
  for (const child of suite.suites ?? []) tests.push(...flatten(child, child.file ?? file));
  return tests;
}

let failed = false;
for (let n = 1; n <= runs; n += 1) {
  const startedAt = new Date().toISOString();
  const report = path.join(out, `run-${n}.playwright.json`);
  const result = spawnSync("npx", ["playwright", "test", "--retries=0", "--reporter=list,json"], {
    cwd: SUITE,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
  });
  const finishedAt = new Date().toISOString();
  const json = JSON.parse(fs.readFileSync(report, "utf8"));
  const tests = json.suites.flatMap((suite) => flatten(suite));
  const receipt = {
    run: n,
    of: runs,
    commit,
    tree,
    worktreeClean: true,
    startedAt,
    finishedAt,
    exitCode: result.status,
    retries: 0,
    stats: json.stats,
    passed: tests.filter((t) => t.status === "expected").length,
    total: tests.length,
    tests,
  };
  fs.writeFileSync(path.join(out, `run-${n}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  fs.rmSync(report);
  console.log(`run ${n}/${runs} at ${commit.slice(0, 8)}: exit ${result.status}, ${receipt.passed}/${receipt.total} passed`);
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
