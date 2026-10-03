import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliHome } from './cli.ts';

// Stub executables stand in for Python: CliHome passes them `-c <code> <args>`,
// which a shell script ignores. Each test points PILOT_CLI_PYTHON at one.
let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cog-pilot-clitest-'));
  // CliHome refuses a source without the CLI package; the stubs never import it.
  await mkdir(join(scratch, 'cogbench'));
  await writeFile(join(scratch, 'cogbench', 'cli.py'), '');
  await writeFile(join(scratch, 'cogbench', '__init__.py'), '');
  process.env.PILOT_CLI_SRC = scratch;
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function stub(name: string, body: string): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test('a CLI that cannot start rejects its waiters, and close still removes HOME', async () => {
  process.env.PILOT_CLI_PYTHON = join(scratch, 'no-such-python');
  const home = await CliHome.create();
  const cli = home.start(['link']);
  await assert.rejects(cli.waitFor(/Open/, 2_000), /could not run/);
  await assert.rejects(cli.exited(2_000), /could not run/);
  await home.close();
  assert.equal(await exists(home.path), false);
});

test('output and exit code come through', async () => {
  process.env.PILOT_CLI_PYTHON = await stub('prints', 'echo "Open http://127.0.0.1:5195/x and confirm code AB12."; exit 3');
  const home = await CliHome.create();
  const cli = home.start(['link']);
  const [, url, code] = await cli.waitFor(/^Open (\S+) and confirm code (\S+)\.$/m, 2_000);
  assert.equal(url, 'http://127.0.0.1:5195/x');
  assert.equal(code, 'AB12');
  assert.equal(await cli.exited(2_000), 3);
  await home.close();
});

test('a CLI that exits first rejects a pattern it never printed', async () => {
  process.env.PILOT_CLI_PYTHON = await stub('quits', 'echo nothing useful; exit 2');
  const home = await CliHome.create();
  await assert.rejects(home.start(['link']).waitFor(/Open/, 2_000), /exited 2 first/);
  await home.close();
});

test('close interrupts a running CLI and waits for it before removing HOME', async () => {
  const seen = join(scratch, 'seen-at-exit');
  // On INT it pauses, then records whether HOME still exists as it exits.
  process.env.PILOT_CLI_PYTHON = await stub(
    'polls',
    `trap 'sleep 0.3; if [ -d "$HOME" ]; then echo present > "${seen}"; else echo gone > "${seen}"; fi; exit 0' INT
echo polling
while :; do sleep 0.05; done`,
  );
  const home = await CliHome.create();
  const cli = home.start(['link']);
  await cli.waitFor(/polling/, 2_000);
  await home.close();
  assert.equal((await readFile(seen, 'utf8')).trim(), 'present');
  assert.equal(await exists(home.path), false);
});

test('a CLI that ignores SIGINT is killed, and close says its cleanup is unconfirmed and keeps HOME', async () => {
  process.env.PILOT_CLI_PYTHON = await stub('stubborn', `trap '' INT TERM\necho stubborn\nwhile :; do sleep 0.05; done`);
  const home = await CliHome.create();
  const cli = home.start(['link']);
  await cli.waitFor(/stubborn/, 2_000);
  await assert.rejects(home.close(), /cogworks link \(killed\) did not exit on SIGINT.*is left in place/);
  assert.equal(await cli.exited(1_000), 128);
  assert.equal(await exists(home.path), true);
  await rm(home.path, { recursive: true, force: true });
});

/* ── An isolated worker, the shape of `cogworks run` ─────────────────────── */

// A stand-in for cogbench.cli with the structure that matters here, from
// cogbench/isolate.py (run_operation, _collect): a scratch TemporaryDirectory,
// a worker started in a session of its own, and a `finally` that kills the
// worker's process group. KeyboardInterrupt becomes exit 130, as in cli.py.
const STUB_CLI = `
import json, os, signal, subprocess, sys, tempfile

def main(argv):
    if os.environ.get("PILOT_TEST_IGNORE_INT"):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        with tempfile.TemporaryDirectory(prefix="cogworks-discovery-") as scratch:
            worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], start_new_session=True)
            with open(os.environ["PILOT_TEST_OBSERVE"], "w") as stream:
                json.dump({"worker": worker.pid, "scratch": scratch}, stream)
            print("worker started", flush=True)
            try:
                worker.wait()
            finally:
                os.killpg(worker.pid, signal.SIGKILL)
                worker.wait()
    except KeyboardInterrupt:
        print("cogworks: interrupted", file=sys.stderr)
        return 130
    return 0
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function isolatedWorkerRun(t: TestContext, ignoreInterrupt: boolean) {
  const python = process.env.PILOT_CLI_PYTHON_REAL ?? 'python3';
  try {
    execFileSync(python, ['-c', 'pass']);
  } catch {
    t.skip(`no Python at ${python}; set PILOT_CLI_PYTHON_REAL to run this regression`);
    return undefined;
  }
  const source = join(scratch, `stub-src-${ignoreInterrupt ? 'ignore' : 'plain'}`);
  await mkdir(join(source, 'cogbench'), { recursive: true });
  await writeFile(join(source, 'cogbench', '__init__.py'), '');
  await writeFile(join(source, 'cogbench', 'cli.py'), STUB_CLI);
  const observe = join(scratch, `observed-${ignoreInterrupt ? 'ignore' : 'plain'}.json`);
  process.env.PILOT_CLI_PYTHON = python;
  process.env.PILOT_CLI_SRC = source;
  process.env.PILOT_TEST_OBSERVE = observe;
  if (ignoreInterrupt) process.env.PILOT_TEST_IGNORE_INT = '1';
  else delete process.env.PILOT_TEST_IGNORE_INT;
  const home = await CliHome.create();
  const cli = home.start(['run']);
  await cli.waitFor(/worker started/, 10_000);
  const { worker, scratch: workerScratch } = JSON.parse(await readFile(observe, 'utf8')) as { worker: number; scratch: string };
  assert.ok(alive(worker), 'the worker is running before close');
  return { home, cli, worker, workerScratch };
}

test('SIGINT lets a CLI with an isolated worker kill it and remove its scratch before HOME goes', async (t) => {
  const run = await isolatedWorkerRun(t, false);
  if (!run) return;
  await run.home.close();
  assert.equal(await run.cli.exited(1_000), 130);
  assert.equal(alive(run.worker), false, 'no worker left');
  assert.equal(await exists(run.workerScratch), false, 'scratch removed');
  assert.equal(await exists(run.home.path), false, 'HOME removed');
});

test('when the CLI ignores SIGINT, close reports the worker it may have left instead of claiming cleanup', async (t) => {
  const run = await isolatedWorkerRun(t, true);
  if (!run) return;
  try {
    await assert.rejects(run.home.close(), /did not exit on SIGINT, so a benchmark worker it started may still be running/);
    // The danger the message names is real: SIGTERM ended Python without its
    // `finally`, so the worker outlived it.
    assert.equal(alive(run.worker), true, 'the worker outlived the killed CLI');
    assert.equal(await exists(run.home.path), true, 'HOME left in place');
  } finally {
    // The worker is this test's own, started moments ago; clean up after it.
    if (alive(run.worker)) process.kill(run.worker, 'SIGKILL');
    await rm(run.workerScratch, { recursive: true, force: true });
    await rm(run.home.path, { recursive: true, force: true });
    delete process.env.PILOT_TEST_IGNORE_INT;
  }
});

test("without PILOT_CLI_SRC the CLI runs from this checkout's own source", async () => {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    encoding: 'utf8',
  }).trim();
  delete process.env.PILOT_CLI_SRC;
  try {
    process.env.PILOT_CLI_PYTHON = await stub('print-pythonpath', 'echo "$PYTHONPATH"');
    const home = await CliHome.create();
    const cli = home.start(['status']);
    assert.equal(await cli.exited(2_000), 0);
    assert.equal(cli.output().trim(), join(top, 'python', 'cogbench', 'src'));
    await home.close();
  } finally {
    process.env.PILOT_CLI_SRC = scratch;
  }
});

test('a source that is not a regular cogbench package with the CLI is refused before anything runs', async () => {
  // Without __init__.py, cogbench there is a namespace package, and an
  // installed regular cogbench later on the path wins over it.
  const cases: Array<[string, string[], string]> = [
    ['empty', [], '__init__.py'],
    ['cli-only', ['cli.py'], '__init__.py'],
    ['init-only', ['__init__.py'], 'cli.py'],
  ];
  process.env.PILOT_CLI_PYTHON = await stub('never-runs', 'exit 0');
  try {
    for (const [name, files, missing] of cases) {
      const source = join(scratch, `not-cogbench-${name}`);
      await mkdir(join(source, 'cogbench'), { recursive: true });
      for (const file of files) await writeFile(join(source, 'cogbench', file), '');
      process.env.PILOT_CLI_SRC = source;
      await assert.rejects(
        CliHome.create(),
        new RegExp(`not-cogbench-${name} has no cogbench/${missing.replace('.', '\\.')}; set PILOT_CLI_SRC`),
        name,
      );
    }
  } finally {
    process.env.PILOT_CLI_SRC = scratch;
  }
});

test('a relative PILOT_CLI_SRC is made absolute before it is checked and passed to Python', async () => {
  // Python starts in the fresh HOME, not here, so a relative PYTHONPATH would
  // name another directory there and fall back to an installed cogbench.
  process.env.PILOT_CLI_SRC = relative(process.cwd(), scratch);
  try {
    process.env.PILOT_CLI_PYTHON = await stub('print-pythonpath-relative', 'echo "$PYTHONPATH"');
    const home = await CliHome.create();
    const cli = home.start(['status']);
    assert.equal(await cli.exited(2_000), 0);
    assert.equal(cli.output().trim(), scratch);
    await home.close();
  } finally {
    process.env.PILOT_CLI_SRC = scratch;
  }
});
