import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  FIXTURE_ORIGIN,
  FIXTURE_REPO_FULL,
  benchmarkPluginId,
  linkDeviceProcess,
  makeFixtureRepo,
} from "../lib/state-gen.mjs";

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test timed out waiting for the link")), ms)),
  ]);
}

function gitOut(cwd, args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// ── linkDeviceProcess ────────────────────────────────────────────────────────

test("linkDeviceProcess survives a CLI that exits while approval is in flight", async () => {
  const script =
    'process.stdout.write("Open http://localhost:3000/connections and confirm code ABC-123.\\n"); process.exit(0);';
  const calls = [];
  const userCode = await withTimeout(
    linkDeviceProcess({
      argv: [process.execPath, "-e", script],
      cwd: tmpdir(),
      env: process.env,
      deviceName: "test device",
      approve: async (route, opts) => calls.push([route, opts]),
    }),
    10_000,
  );
  assert.equal(userCode, "ABC-123");
  assert.equal(calls.length, 1);
  // beta mounts the CLI routes under /api (the old path /v1/... 404'd).
  assert.equal(calls[0][0], "/api/v1/cli/device/approve");
  assert.deepEqual(calls[0][1].body, { userCode: "ABC-123", deviceName: "test device" });
});

test("linkDeviceProcess launches the CLI unbuffered and posts the beta approval route", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.kill = () => {};
    }
  }
  const child = new FakeChild();
  const captured = {};
  const p = linkDeviceProcess({
    argv: ["cogworks", "link", "--portal", "http://x", "--no-browser"],
    cwd: tmpdir(),
    env: { FIXED: "1" },
    deviceName: "dev",
    approve: async (route) => {
      captured.route = route;
    },
    spawnImpl: (cmd, args, opts) => {
      Object.assign(captured, { cmd, args, opts });
      return child;
    },
  });
  child.stdout.emit("data", Buffer.from("Open http://x and confirm code XYZ-99.\n"));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  child.emit("exit", 0, null);
  await withTimeout(p, 5_000);
  // Piped stdout is block-buffered in Python; without PYTHONUNBUFFERED the
  // code line stays in the CLI's buffer and the stage deadlocks to the 45s kill.
  assert.equal(captured.opts.env.PYTHONUNBUFFERED, "1");
  assert.equal(captured.route, "/api/v1/cli/device/approve");
  assert.deepEqual(captured.opts.stdio, ["ignore", "pipe", "pipe"]);
});

test("linkDeviceProcess reports a failed CLI run and an early exit", async () => {
  const fail = linkDeviceProcess({
    argv: [process.execPath, "-e", 'process.stdout.write("confirm code FAIL-COD\\n"); process.exit(2);'],
    cwd: tmpdir(),
    env: process.env,
    deviceName: "d",
    approve: async () => {},
  });
  await assert.rejects(fail, /cogworks link failed \(2\)/);
  const early = linkDeviceProcess({
    argv: [process.execPath, "-e", "process.exit(3);"],
    cwd: tmpdir(),
    env: process.env,
    deviceName: "d",
    approve: async () => {},
  });
  await assert.rejects(early, /exited early \(3\)/);
});

// ── benchmarkPluginId ────────────────────────────────────────────────────────

const WEEK1_PYPROJECT = `# mirrors cogworks-week1-audio-benchmark's declaration
name = "cogworks-week1-audio-benchmark"
version = "0.1.0"

[project.entry-points."cogworks.benchmarks.v2"]
audio-identification = "audio_identification_benchmark.plugins:AudioIdentificationBenchmark"

[tool.setuptools.packages.find]
where = ["src"]
`;

test("benchmarkPluginId reads the declared plugin id, not the directory name", () => {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-suite-plug-"));
  writeFileSync(join(dir, "pyproject.toml"), WEEK1_PYPROJECT);
  assert.equal(benchmarkPluginId(dir), "audio-identification");
});

test("benchmarkPluginId reads a v1 section and refuses a package without entry points", () => {
  const root = mkdtempSync(join(tmpdir(), "upgrade-suite-plug2-"));
  const v1 = join(root, "weekA");
  mkdirSync(v1, { recursive: true });
  writeFileSync(join(v1, "pyproject.toml"), '[project.entry-points."cogworks.benchmarks.v1"]\nlanguage-search = "lang_benchmark.plugins:Lang"\n');
  assert.equal(benchmarkPluginId(v1), "language-search");
  const none = join(root, "weekB");
  mkdirSync(none, { recursive: true });
  writeFileSync(join(none, "pyproject.toml"), "[project]\nname = 'nope'\n");
  assert.throws(() => benchmarkPluginId(none), /no cogworks\.benchmarks/);
  const empty = join(root, "weekC");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "pyproject.toml"), '[project.entry-points."cogworks.benchmarks.v1"]\n');
  assert.throws(() => benchmarkPluginId(empty), /empty cogworks\.benchmarks/);
});

// ── makeFixtureRepo ──────────────────────────────────────────────────────────

test("makeFixtureRepo builds a standalone repo naming the team's fixture origin", () => {
  const example = mkdtempSync(join(tmpdir(), "upgrade-suite-fx-example-"));
  writeFileSync(join(example, "main.py"), "print('week')\n");
  const root = mkdtempSync(join(tmpdir(), "upgrade-suite-fx-"));
  gitOut(root, ["init"]);
  gitOut(root, ["config", "user.name", "Parent Identity"]);
  gitOut(root, ["config", "user.email", "parent@repo.local"]);
  const project = join(root, "nested", "proj");
  makeFixtureRepo(example, project);
  // The repository the CLI reports by walking up from cwd is the fixture's,
  // matching the team's connected repo - not the enclosing checkout's.
  assert.equal(gitOut(project, ["remote", "get-url", "origin"]), FIXTURE_ORIGIN);
  assert.ok(FIXTURE_ORIGIN.includes(FIXTURE_REPO_FULL));
  assert.equal(gitOut(project, ["status", "--porcelain"]), "");
  assert.match(gitOut(project, ["rev-parse", "HEAD"]), /^[0-9a-f]{40}$/);
  // Per-repository identity: the copy has its own, the enclosing repo keeps
  // its own (the regression: the old copy stood inside the suite clone and an
  // identity write through a worktree leaked into the shared config).
  assert.equal(gitOut(project, ["config", "user.name"]), "Upgrade Suite");
  assert.equal(gitOut(root, ["config", "user.name"]), "Parent Identity");
  assert.ok(!existsSync(join(example, ".git")));
  // Rebuilding is a no-op once the standalone repo exists.
  makeFixtureRepo(example, project);
  assert.equal(gitOut(project, ["remote", "get-url", "origin"]), FIXTURE_ORIGIN);
});
